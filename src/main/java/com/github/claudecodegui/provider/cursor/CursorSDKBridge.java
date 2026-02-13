package com.github.claudecodegui.provider.cursor;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;

import java.io.File;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Cursor CLI bridge.
 * Handles Java to Node.js bridge communication and streaming responses.
 */
public class CursorSDKBridge extends BaseSDKBridge {

    public CursorSDKBridge() {
        super(CursorSDKBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "cursor";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("CURSOR_USE_STDIN", "true");
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            boolean[] hadSendError,
            String[] lastNodeError
    ) {
        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
        } else if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        } else if (line.startsWith("[SESSION_ID]")) {
            String sessionId = line.substring("[SESSION_ID]".length()).trim();
            callback.onMessage("session_id", sessionId);
        } else if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "unknown";

                    if ("status".equals(msgType)) {
                        String status = "";
                        if (msg.has("message") && !msg.get("message").isJsonNull()) {
                            JsonElement statusEl = msg.get("message");
                            status = statusEl.isJsonPrimitive() ? statusEl.getAsString() : statusEl.toString();
                        }
                        if (status != null && !status.isEmpty()) {
                            callback.onMessage("status", status);
                        }
                        return;
                    }

                    result.messages.add(msg);

                    if ("assistant".equals(msgType)) {
                        try {
                            String extracted = extractAssistantText(msg);
                            if (extracted != null && !extracted.isEmpty()) {
                                assistantContent.append(extracted);
                            }
                        } catch (Exception ignored) {
                        }
                    }

                    callback.onMessage(msgType, jsonStr);
                }
            } catch (Exception ignored) {
            }
        } else if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError[0] = true;
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
        } else if (line.startsWith("[CURSOR_DIAG]")) {
            String diag = line.substring("[CURSOR_DIAG]".length()).trim();
            LOG.info("[CursorDiag] " + diag);
        }
    }

    /**
     * Send message to Cursor CLI (streaming response).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String cursorMode,
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            final String[] lastNodeError = {null};
            final boolean[] hadSendError = {false};

            try {
                File bridgeDir = getDirectoryResolver().findSdkDir();
                if (bridgeDir == null) {
                    result.success = false;
                    result.error = "Bridge directory not ready yet (extraction in progress)";
                    callback.onError(result.error);
                    return result;
                }

                List<String> command = new ArrayList<>();
                String node = nodeDetector.findNodeExecutable();
                command.add(node);
                String scriptPath = new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath();
                command.add(scriptPath);
                command.add(getProviderName());
                command.add("send");

                JsonObject stdinJson = new JsonObject();
                stdinJson.addProperty("message", message);
                if (sessionId != null) {
                    stdinJson.addProperty("sessionId", sessionId);
                }
                if (cwd != null) {
                    stdinJson.addProperty("cwd", cwd);
                }
                if (model != null) {
                    stdinJson.addProperty("model", model);
                }
                if (permissionMode != null) {
                    stdinJson.addProperty("permissionMode", permissionMode);
                }
                if (cursorMode != null) {
                    stdinJson.addProperty("cursorMode", cursorMode);
                }
                if (attachments != null && !attachments.isEmpty()) {
                    JsonArray attachmentsArray = new JsonArray();
                    for (ClaudeSession.Attachment attachment : attachments) {
                        if (attachment == null) continue;
                        JsonObject attachmentObj = new JsonObject();
                        attachmentObj.addProperty("fileName", attachment.fileName);
                        attachmentObj.addProperty("mediaType", attachment.mediaType);
                        attachmentObj.addProperty("data", attachment.data);
                        attachmentsArray.add(attachmentObj);
                    }
                    if (!attachmentsArray.isEmpty()) {
                        stdinJson.add("attachments", attachmentsArray);
                    }
                }

                SDKResult execResult = executeStreamingCommand(
                        channelId,
                        command,
                        stdinJson.toString(),
                        bridgeDir.getAbsolutePath(),
                        callback
                ).join();

                if (hadSendError[0]) {
                    return execResult;
                }

                execResult.success = true;
                execResult.finalResult = assistantContent.toString();
                return execResult;
            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                callback.onError(result.error);
                return result;
            }
        });
    }

    /**
     * 获取 Cursor 模型列表
     */
    public JsonObject getAvailableModels() {
        try {
            String node = nodeDetector.findNodeExecutable();

            File workDir = getDirectoryResolver().findSdkDir();
            if (workDir == null || !workDir.exists()) {
                throw new RuntimeException("Bridge directory not ready or invalid");
            }

            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(CHANNEL_SCRIPT);
            command.add(getProviderName());
            command.add("listModels");

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            envConfigurator.updateProcessEnvironment(pb, node);

            Process process = pb.start();

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            process.waitFor();

            String jsonStr = extractLastJsonLine(output.toString().trim());
            if (jsonStr == null) {
                throw new RuntimeException("Failed to extract JSON from Cursor models output");
            }

            return gson.fromJson(jsonStr, JsonObject.class);
        } catch (Exception e) {
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    /**
     * Extract last JSON object line from mixed output.
     */
    private String extractLastJsonLine(String output) {
        if (output == null || output.isEmpty()) return null;
        String[] lines = output.split("\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (line.startsWith("{") && line.endsWith("}")) {
                return line;
            }
        }
        return null;
    }

    private String extractAssistantText(JsonObject msg) {
        if (msg == null) return "";
        if (!msg.has("message") || !msg.get("message").isJsonObject()) return "";

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) return "";

        JsonElement contentEl = message.get("content");
        if (contentEl.isJsonPrimitive()) {
            return contentEl.getAsString();
        }
        if (!contentEl.isJsonArray()) {
            return "";
        }

        JsonArray arr = contentEl.getAsJsonArray();
        StringBuilder sb = new StringBuilder();
        for (JsonElement el : arr) {
            if (!el.isJsonObject()) continue;
            JsonObject block = el.getAsJsonObject();
            if (!block.has("type") || block.get("type").isJsonNull()) continue;
            String type = block.get("type").getAsString();
            if ("text".equals(type) && block.has("text") && !block.get("text").isJsonNull()) {
                if (sb.length() > 0) sb.append("\n");
                sb.append(block.get("text").getAsString());
            }
        }
        return sb.toString();
    }
}
