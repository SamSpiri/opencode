export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import {
  AssistantMessage,
  CacheHint,
  LLMClient,
  Message,
  SystemMessage,
  ToolMessage,
  UserMessage,
  type AIError,
  type ContentPart,
} from "@opencode/ai/effect"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionModelRequest } from "./model-request.js"
import { ModelRetry } from "../model-retry.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

export type Result = SessionUsage.Recorded & { readonly text: string }

/**
 * Generates text from current Session context without mutating history.
 * Usage is reported like a step's and added to the Session's totals.
 */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const model = yield* context.resolveModel(selection.session, { kind: "generate", agent: selection.agent.id })
    const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    const markedMessages =
      transcript.messages.length > 0
        ? [
            ...markHistoryBoundary(transcript.messages),
            ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
          ]
        : history.instructionUpdate
          ? markHistoryBoundary([Message.system(history.instructionUpdate)])
          : []
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...markedMessages,
        Message.user(input.prompt),
      ],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    const response = yield* llm.generate(prepared.request, prepared.options).pipe(ModelRetry.retry)
    yield* Effect.logInfo("session generation usage diagnostic", {
      sessionID: input.session.id,
      usage: response.usage,
    })
    const usage = SessionUsage.record(response.usage, model.cost)
    yield* bus.publish(SessionEvent.UsageRecorded, { sessionID: selection.session.id, source: "generate", ...usage })
    return { text: response.text, ...usage }
  }).pipe(instances.provide(input.session))
})

function markHistoryBoundary(messages: Array<Message>): Array<Message> {
  const last = messages.at(-1)
  if (!last || last.content.length === 0) return messages
  const lastText = last.content.findLastIndex((part) => part.type === "text")
  const index = lastText >= 0 ? lastText : last.content.findLastIndex((part) => part.type !== "compaction" && part.type !== "effort")
  const part = last.content[index]
  if (!part || ("cache" in part && part.cache)) return messages
  const next = (() => {
    switch (last.role) {
      case "assistant":
        return new AssistantMessage({ ...last, content: markContent(last.content, index) })
      case "system":
        return new SystemMessage({ ...last, content: markContent(last.content, index) })
      case "tool":
        return new ToolMessage({ ...last, content: markContent(last.content, index) })
      case "user":
        return new UserMessage({ ...last, content: markContent(last.content, index) })
    }
  })()
  return [...messages.slice(0, -1), next]
}

const markContent = <Part extends ContentPart>(content: ReadonlyArray<Part>, index: number) =>
  content.map((part, i) => (i === index ? { ...part, cache: new CacheHint({ type: "ephemeral" }) } : part))
