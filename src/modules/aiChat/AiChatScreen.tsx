import { MainLayout } from "@/components/layout/Layout";
import { pb } from "@/config/pocketbaseConfig";
import {
  AssistantTextMessage,
  ErrorMessage,
  UserTextMessage,
} from "@/modules/aiChat/components/Messages";
import { ScrollContainer } from "@/modules/aiChat/components/ScrollContainer";
import { useAiThreadRecordsStore } from "@/modules/aiThreads/aiThreadRecordsStore";
import { useAnthropicStore } from "@/modules/providers/anthropicStore";
import { ErrorScreen } from "@/screens/ErrorScreen";
import { LoadingScreen } from "@/screens/LoadingScreen";
import React, { useState } from "react";
import { useAiTextMessageRecordsStore } from "../aiTextMessages/aiTextMessageRecordsStore";
import { createAiTextMessageRecord } from "../aiTextMessages/dbAiTextMessageUtils";
import {
  createAiThreadRecord,
  updateAiThreadRecordTitle,
} from "../aiThreads/dbAiThreadRecordUtils";
import {
  callAnthropic,
  createAnthropicTextMessage,
  createTitleForMessageThreadWithAnthropic,
} from "../providers/anthropicApi";
import { AiInputTextForm } from "./components/AiInputTextForm";

export const AiChatScreen = (p: { threadFriendlyId: string }) => {
  const threadFriendlyId = p.threadFriendlyId;

  const aiThreadRecordsStore = useAiThreadRecordsStore();
  const currentThread = aiThreadRecordsStore.data?.find((x) => x.friendlyId === threadFriendlyId);

  const aiTextMessagesRecordsStore = useAiTextMessageRecordsStore();
  const aiTextMessageRecords = currentThread?.id
    ? aiTextMessagesRecordsStore.getMessagesByThreadId(currentThread.id)
    : undefined;

  const aiTextWithMediaRecords = (aiTextMessageRecords ?? []).sort((a, b) =>
    a.created < b.created ? -1 : 1,
  );

  const anthropicStore = useAnthropicStore();
  const anthropicInstance = anthropicStore.data;
  const [mode, setMode] = useState<"ready" | "thinking" | "streaming" | "error">("ready");
  const [streamedText, setStreamedText] = useState("");

  if (aiThreadRecordsStore.data === undefined) return <LoadingScreen />;
  if (aiThreadRecordsStore.data === null) return <ErrorScreen />;

  return (
    <MainLayout fillPageExactly padding={false}>
      <div className="flex h-full flex-col">
        <ScrollContainer scrollToBottomDeps={[threadFriendlyId]}>
          <div className="p-4 pb-0">
            {aiTextWithMediaRecords.length === 0 && (
              <AssistantTextMessage>Hello! How can I help you today?</AssistantTextMessage>
            )}
            {aiTextWithMediaRecords.map((x) => {
              if (x.role === "assistant")
                return <AssistantTextMessage key={x.id}>{x.contentText}</AssistantTextMessage>;

              return <UserTextMessage key={x.id}>{x.contentText}</UserTextMessage>;
            })}

            {mode === "thinking" && <p>Thinking...</p>}
            {mode === "streaming" && <AssistantTextMessage>{streamedText}</AssistantTextMessage>}
            {mode === "error" && <ErrorMessage />}
          </div>
        </ScrollContainer>

        <div className="p-4 pt-1">
          {anthropicInstance ? (
            <AiInputTextForm
              disabled={mode === "thinking" || mode === "streaming"}
              onSubmit={async (x) => {
                setMode("thinking");
                const resp = await (async (): Promise<
                  { success: false; error: string } | { success: true }
                > => {
                  const thread = await (async () => {
                    if (currentThread) return currentThread;

                    const resp = await createAiThreadRecord({
                      pb,
                      data: { friendlyId: threadFriendlyId, title: "" },
                    });
                    if (resp.success) return resp.data;
                  })();

                  if (!thread) return { success: false, error: "thread not found" };
                  const threadId = thread.id;

                  const createAiTextMessageRecordResp = await createAiTextMessageRecord({
                    pb,
                    data: { threadId, role: "user", contentText: x.text },
                  });

                  if (!createAiTextMessageRecordResp.success)
                    return { success: false, error: "create ai text message failed" };

                  const anthropicMessages = [
                    ...aiTextWithMediaRecords.map((x) =>
                      createAnthropicTextMessage({ role: x.role, text: x.contentText }),
                    ),
                    createAnthropicTextMessage({ role: "user", text: x.text }),
                  ];

                  if (anthropicMessages.length > 2 && !thread.title) {
                    createTitleForMessageThreadWithAnthropic({
                      anthropic: anthropicInstance,
                      messages: anthropicMessages,
                    }).then((resp) => {
                      if (resp.success)
                        updateAiThreadRecordTitle({ pb, id: thread.id, title: resp.data });
                    });
                  }

                  const anthropicResp = await callAnthropic({
                    anthropic: anthropicInstance,
                    messages: anthropicMessages,
                    onStreamStatusChange: (x) => setMode(x === "finished" ? "ready" : x),
                    onStreamChange: (text) => setStreamedText(text),
                  });

                  if (!anthropicResp.success)
                    return { success: false, error: "anthropic call failed" };

                  const createAssistantAiTextMessageRecordResp = await createAiTextMessageRecord({
                    pb,
                    data: { threadId, role: "assistant", contentText: anthropicResp.data },
                  });

                  if (!createAssistantAiTextMessageRecordResp.success)
                    return { success: false, error: "create assistant ai text message failed" };

                  return { success: true };
                })();

                setMode(resp.success ? "ready" : "error");
              }}
            />
          ) : (
            <div>No AI instance</div>
          )}
        </div>
      </div>
    </MainLayout>
  );
};
