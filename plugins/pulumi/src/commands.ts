/*
 * Copyright (C) 2018-2025 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import type {
  ConfigGraph,
  Garden,
  GraphResults,
  PluginCommand,
  PluginCommandParams,
  PluginContext,
} from "@garden-io/sdk/build/src/types.js"
import { BuildTask, PluginActionTask } from "@garden-io/sdk/build/src/types.js"

import type { PulumiDeploy } from "./action.js"
import type { PulumiProvider } from "./provider.js"
import { Profile } from "@garden-io/core/build/src/util/profiling.js"
import type { OperationCounts, PreviewResult, PulumiParams } from "./helpers.js"
import {
  cancelUpdate,
  getModifiedPlansDirPath,
  getPlanFileName,
  getPreviewDirPath,
  previewStack,
  refreshResources,
  reimportStack,
  selectStack,
} from "./helpers.js"
import { dedent, deline } from "@garden-io/sdk/build/src/util/string.js"
import { BooleanParameter, parsePluginCommandArgs } from "@garden-io/sdk/build/src/util/cli.js"
import fsExtra from "fs-extra"

const { copy, emptyDir, writeJSON } = fsExtra
import { join } from "path"
import { isBuildAction } from "@garden-io/core/build/src/actions/build.js"
import { isDeployAction } from "@garden-io/core/build/src/actions/deploy.js"
import type { ActionTaskProcessParams, BaseTask, ValidResultType } from "@garden-io/core/build/src/tasks/base.js"
import { deletePulumiDeploy } from "./handlers.js"
import type { ActionLog, Log } from "@garden-io/core/build/src/logger/log-entry.js"
import { createActionLog } from "@garden-io/core/build/src/logger/log-entry.js"
import { ActionSpecContext } from "@garden-io/core/build/src/config/template-contexts/actions.js"
import type { ProviderMap } from "@garden-io/core/build/src/config/provider.js"
import { styles } from "@garden-io/core/build/src/logger/styles.js"
import { isTruthy } from "@garden-io/core/build/src/util/util.js"
import { InputContext } from "@garden-io/core/build/src/config/template-contexts/input.js"
import { TemplatableConfigContext } from "@garden-io/core/build/src/config/template-contexts/templatable.js"

type PulumiBaseParams = Omit<PulumiParams, "action">

type PulumiRunFn = (params: PulumiParams) => Promise<PulumiCommandResult>

interface PulumiCommandSpec {
  name: string
  commandDescription: string
  beforeFn?: ({ ctx, log }: { ctx: PluginContext; log: Log }) => Promise<any>
  runFn: PulumiRunFn
  afterFn?: ({
    ctx,
    log,
    results,
    pulumiTasks,
  }: {
    ctx: PluginContext
    log: Log
    results: GraphResults
    pulumiTasks: PulumiPluginCommandTask[]
  }) => Promise<any>
}

interface TotalSummary {
  /**
   * The ISO timestamp of when the plan was completed.
   */
  completedAt: string
  /**
   * The total number of operations by step type (excluding `same` steps).
   */
  totalStepCounts: OperationCounts
  /**
   * A more detailed summary for each pulumi service affected by the plan.
   */
  results: {
    [serviceName: string]: PreviewResult
  }
}

const pulumiCommandSpecs: PulumiCommandSpec[] = [
  {
    name: "preview",
    commandDescription: "pulumi preview",
    beforeFn: async ({ ctx, log }) => {
      const previewDirPath = getPreviewDirPath(ctx)
      // We clear the preview dir, so that it contains only the plans generated by this preview command.
      log.debug(`Clearing preview dir at ${previewDirPath}...`)
      await emptyDir(previewDirPath)
    },
    runFn: async (params) => {
      const { ctx, action, log } = params
      const previewDirPath = getPreviewDirPath(ctx)
      const { affectedResourcesCount, operationCounts, previewUrl, planPath } = await previewStack({
        ...params,
        logPreview: true,
        previewDirPath,
      })
      if (affectedResourcesCount > 0) {
        // We copy the plan to a subdirectory of the preview dir.
        // This is to facilitate copying only those plans that aren't no-ops out of the preview dir for subsequent
        // use in a deployment.
        const planFileName = getPlanFileName(action, ctx.environmentName)
        const modifiedPlanPath = join(getModifiedPlansDirPath(ctx), planFileName)
        await copy(planPath, modifiedPlanPath)
        log.debug(`Copied plan to ${modifiedPlanPath}`)
        return {
          state: "ready",
          outputs: {
            affectedResourcesCount,
            operationCounts,
            modifiedPlanPath,
            previewUrl,
          },
        }
      } else {
        return {
          state: "ready",
          outputs: {},
        }
      }
    },
    afterFn: async ({ ctx, log, results, pulumiTasks }) => {
      // No-op plans (i.e. where no resources were changed) are omitted here.
      const pulumiTaskResults: { [name: string]: PreviewResult } = Object.fromEntries(
        pulumiTasks
          .map((t) => {
            const outputs = results.getResult(t)?.outputs
            return outputs && Object.keys(outputs).length > 0 ? [t.getName(), outputs] : null
          })
          .filter(isTruthy)
      )
      const totalStepCounts: OperationCounts = {}
      for (const result of Object.values(pulumiTaskResults)) {
        const opCounts = result.operationCounts
        for (const [stepType, count] of Object.entries(opCounts)) {
          totalStepCounts[stepType] = (totalStepCounts[stepType] || 0) + count
        }
      }
      const totalSummary: TotalSummary = {
        completedAt: new Date().toISOString(),
        totalStepCounts,
        results: pulumiTaskResults,
      }
      const previewDirPath = getPreviewDirPath(ctx)
      const summaryPath = join(previewDirPath, "plan-summary.json")
      await writeJSON(summaryPath, totalSummary, { spaces: 2 })
      log.info("")
      log.info(styles.success(`Wrote plan summary to ${styles.accent(summaryPath)}`))
      return totalSummary
    },
  },
  {
    name: "cancel",
    commandDescription: "pulumi cancel",
    runFn: async (params) => await cancelUpdate(params),
  },
  {
    name: "refresh",
    commandDescription: "pulumi refresh",
    runFn: async (params) => await refreshResources(params),
  },
  {
    name: "reimport",
    commandDescription: "pulumi export | pulumi import",
    runFn: async (params) => await reimportStack(params),
  },
  {
    name: "destroy",
    commandDescription: "pulumi destroy",
    runFn: async (params) => {
      if (params.action.getSpec("allowDestroy")) {
        return await deletePulumiDeploy!(params)
      }
      // do nothing and return ready if allowDestory is not set
      return {
        state: "ready",
        outputs: {},
      }
    },
  },
]

const makePluginContextForDeploy = async (
  params: PulumiParams & {
    garden: Garden
    graph: ConfigGraph
    resolvedProviders: ProviderMap
  }
) => {
  const { garden, graph, provider, resolvedProviders, ctx, action } = params
  const templateContext = new ActionSpecContext({
    garden,
    resolvedProviders,
    action,
    modules: graph.getModules(),
    resolvedDependencies: action.getResolvedDependencies(),
    executedDependencies: action.getExecutedDependencies(),
    inputs: new InputContext(action.getInternal().inputs),
    variables: action.getVariablesContext(),
  })
  const ctxForDeploy = await garden.getPluginContext({ provider, templateContext, events: ctx.events })
  return ctxForDeploy
}

interface PulumiPluginCommandTaskParams {
  garden: Garden
  graph: ConfigGraph
  log: ActionLog
  action: PulumiDeploy
  commandName: string
  commandDescription: string
  skipRuntimeDependencies: boolean
  runFn: PulumiRunFn
  pulumiParams: PulumiBaseParams
  resolvedProviders: ProviderMap
}

export type PulumiCommandResult = ValidResultType

@Profile()
class PulumiPluginCommandTask extends PluginActionTask<PulumiDeploy, PulumiCommandResult> {
  override readonly statusConcurrencyLimit: number
  override readonly executeConcurrencyLimit: number

  pulumiParams: PulumiBaseParams
  commandName: string
  commandDescription: string
  override skipRuntimeDependencies: boolean
  runFn: PulumiRunFn
  resolvedProviders: ProviderMap

  constructor({
    garden,
    graph,
    log,
    action,
    commandName,
    commandDescription,
    skipRuntimeDependencies = false,
    runFn,
    pulumiParams,
    resolvedProviders,
  }: PulumiPluginCommandTaskParams) {
    super({
      garden,
      log,
      force: false,
      action,
      graph,
    })
    this.commandName = commandName
    this.commandDescription = commandDescription
    this.skipRuntimeDependencies = skipRuntimeDependencies
    this.runFn = runFn
    this.pulumiParams = pulumiParams
    const provider = <PulumiProvider>pulumiParams.ctx.provider
    this.statusConcurrencyLimit = this.executeConcurrencyLimit = provider.config.pluginTaskConcurrencyLimit
    this.resolvedProviders = resolvedProviders
  }

  getDescription() {
    return this.action.longDescription()
  }

  /**
   * Override the base method to be sure that `garden plugins pulumi preview` happens in dependency order.
   */
  override resolveProcessDependencies() {
    const buildTasks = this.graph
      .getDependencies({
        kind: "Deploy",
        name: this.getName(),
        recursive: false,
      })
      .filter(isBuildAction)
      .map((action) => {
        return new BuildTask({
          garden: this.garden,
          log: this.log,
          action,
          graph: this.graph,
          force: false,
        })
      })
    const tasks: BaseTask[] = [this.getResolveTask(this.action), ...buildTasks]

    const pulumiDeployNames = this.graph
      .getDeploys()
      .filter((d) => d.type === "pulumi")
      .map((d) => d.name)

    if (!this.skipRuntimeDependencies) {
      const deployTasks = this.graph
        .getDependencies({
          kind: "Deploy",
          name: this.getName(),
          recursive: false,
          filter: (depNode) => pulumiDeployNames.includes(depNode.name),
        })
        .filter(isDeployAction)
        .map((action) => {
          return new PulumiPluginCommandTask({
            garden: this.garden,
            graph: this.graph,
            log: this.log,
            action,
            commandName: this.commandName,
            commandDescription: this.commandDescription,
            skipRuntimeDependencies: this.skipRuntimeDependencies,
            runFn: this.runFn,
            pulumiParams: this.pulumiParams,
            resolvedProviders: this.resolvedProviders,
          })
        })
      tasks.push(...deployTasks)
    }

    return tasks
  }

  async getStatus() {
    return null
  }

  async process({ dependencyResults }: ActionTaskProcessParams<PulumiDeploy, PulumiCommandResult>) {
    this.log.info(`Running ${styles.command(this.commandDescription)}`)

    const params = {
      ...this.pulumiParams,
      action: this.getResolvedAction(this.action, dependencyResults),
      resolvedProviders: this.resolvedProviders,
    }

    try {
      await selectStack(params)
      // We need to make sure that the template resolution context is specific to this service's module.
      const ctxForService = await makePluginContextForDeploy({
        ...params,
        garden: this.garden,
        graph: this.graph,
      })
      const result = await this.runFn({ ...params, ctx: ctxForService })
      this.log.success("Success")
      return result
    } catch (err) {
      this.log.error("Failed")
      throw err
    }
  }
}

export const getPulumiCommands = (): PluginCommand[] => pulumiCommandSpecs.map(makePulumiCommand)

function makePulumiCommand({ name, commandDescription, beforeFn, runFn, afterFn }: PulumiCommandSpec) {
  const description = commandDescription || `pulumi ${name}`
  const pulumiCommand = styles.bold(description)

  const pulumiCommandOpts = {
    "skip-dependencies": new BooleanParameter({
      help: deline`Run ${pulumiCommand} for the specified services, but not for any pulumi services that they depend on
      (unless they're specified too).`,
      aliases: ["nodeps"],
    }),
  }

  return {
    name,
    description: dedent`
      Runs ${pulumiCommand} for the specified pulumi actions, in dependency order (or for all pulumi actions if no
      names are provided).

      If the --skip-dependencies option is used, ${pulumiCommand} will only be run for the specified actions, but not any pulumi actions that they depend on (unless they're specified too).

      Note: The --skip-dependencies option has to be put after the -- when invoking pulumi plugin commands.
    `,
    resolveGraph: true,

    title: ({ args }) =>
      styles.command(`Running ${styles.accent.bold(pulumiCommand)} for actions ${styles.accent.bold(args[0] || "")}`),

    async handler({ garden, ctx, args, log, graph }: PluginCommandParams) {
      const parsed = parsePluginCommandArgs({
        stringArgs: args,
        optionSpec: pulumiCommandOpts,
        cli: true,
      })
      const { args: parsedArgs, opts } = parsed
      const skipRuntimeDependencies = opts["skip-dependencies"]
      const names = parsedArgs.length === 0 ? undefined : parsedArgs

      beforeFn && (await beforeFn({ ctx, log }))

      const pulumiProvider = ctx.provider as PulumiProvider
      const actions = graph.getDeploys({ names }).filter((a) => a.type === "pulumi")
      const resolvedProviders = await garden.resolveProviders({ log })

      const tasks = await Promise.all(
        actions.map(async (action) => {
          const templateContext = new TemplatableConfigContext(garden, action.getConfig())
          const actionLog = createActionLog({ log, actionName: action.name, actionKind: action.kind })

          const pulumiParams: PulumiBaseParams = {
            ctx: await garden.getPluginContext({ provider: pulumiProvider, templateContext, events: ctx.events }),
            provider: pulumiProvider,
            log: actionLog,
          }

          return new PulumiPluginCommandTask({
            garden,
            graph,
            resolvedProviders,
            log: actionLog,
            action,
            commandName: name,
            commandDescription,
            skipRuntimeDependencies,
            runFn,
            pulumiParams,
          })
        })
      )

      const results = (await garden.processTasks({ tasks, throwOnError: true })).results

      let commandResult: any = {}
      if (afterFn) {
        commandResult = await afterFn({ ctx, log, results, pulumiTasks: tasks })
      }

      return { result: commandResult }
    },
  }
}
