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
import {
  createAiTextMessageRecord,
  TAiTextMessageRecord,
} from "../aiTextMessages/dbAiTextMessageUtils";
import {
  createAiThreadRecord,
  updateAiThreadRecordTitle,
} from "../aiThreads/dbAiThreadRecordUtils";
import {
  callAnthropic,
  createAnthropicMessage,
  createTitleForMessageThreadWithAnthropic,
} from "../providers/anthropicApi";
import { AiInputTextForm } from "./components/AiInputTextForm";

export const createAnthropicMessageFromAiTextAndMediaMessageWithCachedFileRecords = async (p: {
  textMessage: TAiTextMessageRecord;
}) => {
  return createAnthropicMessage({
    role: p.textMessage.role,
    content: [{ type: "text", text: p.textMessage.contentText }],
  });
};

export const AiChatScreen = (p: { threadFriendlyId: string }) => {
  const threadFriendlyId = p.threadFriendlyId;

  const aiThreadRecordsStore = useAiThreadRecordsStore();
  const currentThread = aiThreadRecordsStore.data?.find((x) => x.friendlyId === threadFriendlyId);

  const aiTextMessagesRecordsStore = useAiTextMessageRecordsStore();
  const aiTextMessageRecords = currentThread?.id
    ? aiTextMessagesRecordsStore.getMessagesByThreadId(currentThread.id)
    : undefined;

  const aiTextWithMediaRecords = (aiTextMessageRecords ?? [])
    .map((x) => ({
      textMessage: x,
    }))
    .sort((a, b) => (a.textMessage.created < b.textMessage.created ? -1 : 1));

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
              if (x.textMessage.role === "assistant")
                return (
                  <AssistantTextMessage key={x.textMessage.id}>
                    {x.textMessage.contentText}
                  </AssistantTextMessage>
                );

              return (
                <React.Fragment key={x.textMessage.id}>
                  <UserTextMessage key={x.textMessage.id}>
                    {x.textMessage.contentText}
                  </UserTextMessage>
                </React.Fragment>
              );
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

                  const createAiTextMessageRecordResp = await createAiTextMessageRecord({
                    pb,
                    data: { threadId: thread.id, role: "user", contentText: x.text },
                  });

                  if (!createAiTextMessageRecordResp.success)
                    return { success: false, error: "create ai text message failed" };

                  const newUserMessage = createAnthropicMessage({
                    role: "user",
                    content: [{ type: "text", text: x.text }],
                  });

                  const anthropicMessagesFromRecords = await Promise.all(
                    aiTextWithMediaRecords.map((x) =>
                      createAnthropicMessage({
                        role: x.textMessage.role,
                        content: [{ type: "text", text: x.textMessage.contentText }],
                      }),
                    ),
                  );

                  const anthropicMessages = [...anthropicMessagesFromRecords, newUserMessage];
                  if (anthropicMessages.length > 2 && !thread.title) {
                    const resp = await createTitleForMessageThreadWithAnthropic({
                      anthropic: anthropicInstance,
                      messages: anthropicMessages,
                    });
                    if (resp.success)
                      updateAiThreadRecordTitle({ pb, id: thread.id, title: resp.data });
                  }

                  const anthropicResp = await callAnthropic({
                    anthropic: anthropicInstance,
                    messages: anthropicMessages,
                    onStreamStatusChange: (x) => setMode(x === "finished" ? "ready" : x),
                    onStreamChange: (text) => setStreamedText(text),
                  });

                  if (!anthropicResp.success) {
                    console.error(anthropicResp);
                    return { success: false, error: "anthropic call failed" };
                  }

                  await createAiTextMessageRecord({
                    pb,
                    data: {
                      threadId: thread.id,
                      role: "assistant",
                      contentText: anthropicResp.data,
                    },
                  });

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
