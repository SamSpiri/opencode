export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { CacheHint, LLMClient, Message, type AIError, type ContentPart } from "@opencode/ai"
import { Effect } from "effect"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionModelRequest } from "./model-request.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

/** Generates text from current Session context without mutating the Session. */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const model = yield* context.resolveModel(selection.session)
    const history = yield* SessionHistory.preview(
      database.db,
      selection.session.id,
      selection.instructions,
      SessionProviderContext.provenance(model) ?? "local",
    )
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    const historyMessages = [
      ...transcript.messages,
      ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
    ]
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...markHistoryBoundary(historyMessages),
        Message.user(input.prompt),
      ],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    const response = yield* llm.generate(prepared.request, prepared.options)
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    return response.text
  }).pipe(instances.provide(input.session))
})

function markHistoryBoundary(messages: Array<Message>): Array<Message> {
  const last = messages.at(-1)
  if (!last || last.content.length === 0) return messages
  const lastText = last.content.findLastIndex((p) => p.type === "text")
  const index = lastText >= 0 ? lastText : last.content.length - 1
  const part = last.content[index]
  if (!part || ("cache" in part && part.cache)) return messages
  const marked = { ...part, cache: new CacheHint({ type: "ephemeral" }) } as ContentPart
  const content = last.content.map((p, i) => (i === index ? marked : p))
  return [...messages.slice(0, -1), new Message({ ...last, content })]
}
