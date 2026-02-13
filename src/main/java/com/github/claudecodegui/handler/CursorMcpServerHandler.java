package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Cursor MCP Server Handler
 * 使用 cursor-agent mcp 子命令查询和切换 MCP 状态
 */
public class CursorMcpServerHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CursorMcpServerHandler.class);
    private static final Gson GSON = new Gson();

    private static final Pattern SERVER_STATUS_PATTERN = Pattern.compile("^\\s*([^:]+):\\s*(.+)\\s*$");
    private static final Pattern TOOL_PATTERN = Pattern.compile("^\\s*[-*•]\\s*([\\w./:-]+)(?:\\s*\\(([^)]*)\\))?\\s*$");
    private static final Pattern TOOL_INDEXED_PATTERN = Pattern.compile("^\\s*\\d+[.)]\\s*([\\w./:-]+)(?:\\s*\\(([^)]*)\\))?\\s*$");
    private static final Pattern TOOLS_HEADER_PATTERN = Pattern.compile("^\\s*Tools\\s+for\\s+.+\\((\\d+)\\):\\s*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern ANSI_ESCAPE_PATTERN = Pattern.compile("\u001B\\[[;\\d?]*[ -/]*[@-~]");
    private static final Pattern LEADING_PROGRESS_GARBAGE = Pattern.compile("^(?:\\[\\d+[A-Z])+");

    private static final int PROCESS_TIMEOUT_SECONDS = 20;

    private static final String[] SUPPORTED_TYPES = {
        "get_cursor_mcp_servers",
        "get_cursor_mcp_server_status",
        "get_cursor_mcp_server_tools",
        "toggle_cursor_mcp_server"
    };

    public CursorMcpServerHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_cursor_mcp_servers":
                handleGetMcpServers();
                return true;
            case "get_cursor_mcp_server_status":
                handleGetMcpServerStatus();
                return true;
            case "get_cursor_mcp_server_tools":
                handleGetMcpServerTools(content);
                return true;
            case "toggle_cursor_mcp_server":
                handleToggleMcpServer(content);
                return true;
            default:
                return false;
        }
    }

    private void handleGetMcpServers() {
        try {
            String cwd = getProjectBasePath();
            CommandResult result = runCursorMcpCommand(List.of("list"), cwd);

            if (!result.success) {
                LOG.warn("[CursorMcpServerHandler] cursor-agent mcp list failed: " + result.error);
                ApplicationManager.getApplication().invokeLater(() ->
                    callJavaScript("window.updateCursorMcpServers", escapeJs("[]"))
                );
                return;
            }

            List<JsonObject> servers = parseServersFromListOutput(result.lines);
            String json = GSON.toJson(servers);

            ApplicationManager.getApplication().invokeLater(() ->
                callJavaScript("window.updateCursorMcpServers", escapeJs(json))
            );
        } catch (Exception e) {
            LOG.error("[CursorMcpServerHandler] Failed to get Cursor MCP servers: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                callJavaScript("window.updateCursorMcpServers", escapeJs("[]"))
            );
        }
    }

    private void handleGetMcpServerStatus() {
        try {
            String cwd = getProjectBasePath();
            CommandResult result = runCursorMcpCommand(List.of("list"), cwd);

            if (!result.success) {
                LOG.warn("[CursorMcpServerHandler] cursor-agent mcp list failed: " + result.error);
                ApplicationManager.getApplication().invokeLater(() ->
                    callJavaScript("window.updateCursorMcpServerStatus", escapeJs("[]"))
                );
                return;
            }

            List<JsonObject> statusList = parseStatusFromListOutput(result.lines);
            String json = GSON.toJson(statusList);

            ApplicationManager.getApplication().invokeLater(() ->
                callJavaScript("window.updateCursorMcpServerStatus", escapeJs(json))
            );
        } catch (Exception e) {
            LOG.error("[CursorMcpServerHandler] Failed to get Cursor MCP server status: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                callJavaScript("window.updateCursorMcpServerStatus", escapeJs("[]"))
            );
        }
    }

    private void handleGetMcpServerTools(String content) {
        String serverId = null;
        try {
            JsonObject payload = GSON.fromJson(content, JsonObject.class);
            if (payload == null || !payload.has("serverId") || payload.get("serverId").isJsonNull()) {
                return;
            }

            serverId = payload.get("serverId").getAsString();
            String cwd = getProjectBasePath();
            CommandResult result = runCursorMcpCommand(List.of("list-tools", serverId), cwd);

            // 某些环境下 list-tools 会返回 "has not been approved"，这里自动 enable 后重试一次。
            if (isNotApprovedResult(result)) {
                result = retryAfterEnable(serverId, cwd, result);
            }

            JsonObject response = new JsonObject();
            response.addProperty("serverId", serverId);
            response.addProperty("serverName", serverId);

            if (!result.success) {
                response.add("tools", new JsonArray());
                response.addProperty("error", result.error != null ? result.error : "Failed to list tools");
            } else {
                JsonArray tools = parseToolsFromListToolsOutput(result.lines);
                // 成功但解析不到工具时，检查是否实际上是 approval 错误（某些版本 exitCode=0）
                if (tools.size() == 0 && isNotApprovedLines(result.lines)) {
                    result = retryAfterEnable(serverId, cwd, result);
                    if (result.success) {
                        tools = parseToolsFromListToolsOutput(result.lines);
                    } else {
                        response.add("tools", new JsonArray());
                        response.addProperty("error", result.error != null ? result.error : "Failed to list tools");
                        String json = GSON.toJson(response);
                        ApplicationManager.getApplication().invokeLater(() ->
                            callJavaScript("window.updateCursorMcpServerTools", escapeJs(json))
                        );
                        return;
                    }
                }
                response.add("tools", tools);
            }

            String json = GSON.toJson(response);
            ApplicationManager.getApplication().invokeLater(() ->
                callJavaScript("window.updateCursorMcpServerTools", escapeJs(json))
            );
        } catch (Exception e) {
            LOG.error("[CursorMcpServerHandler] Failed to get Cursor MCP server tools: " + e.getMessage(), e);
            if (serverId != null) {
                JsonObject response = new JsonObject();
                response.addProperty("serverId", serverId);
                response.addProperty("serverName", serverId);
                response.add("tools", new JsonArray());
                response.addProperty("error", e.getMessage());
                String json = GSON.toJson(response);
                ApplicationManager.getApplication().invokeLater(() ->
                    callJavaScript("window.updateCursorMcpServerTools", escapeJs(json))
                );
            }
        }
    }

    private void handleToggleMcpServer(String content) {
        try {
            JsonObject payload = GSON.fromJson(content, JsonObject.class);
            if (payload == null || !payload.has("id")) {
                return;
            }

            String serverId = payload.get("id").getAsString();
            boolean enabled = !payload.has("enabled") || payload.get("enabled").getAsBoolean();
            String command = enabled ? "enable" : "disable";

            String cwd = getProjectBasePath();
            CommandResult result = runCursorMcpCommand(List.of(command, serverId), cwd);
            if (!result.success) {
                String reason = result.error != null ? result.error : ("Failed to " + command + " MCP server");
                LOG.warn("[CursorMcpServerHandler] " + reason);
                ApplicationManager.getApplication().invokeLater(() ->
                    callJavaScript("window.showError", escapeJs("切换 Cursor MCP 服务器失败: " + reason))
                );
                return;
            }

            // 切换后刷新
            handleGetMcpServers();
            handleGetMcpServerStatus();
        } catch (Exception e) {
            LOG.error("[CursorMcpServerHandler] Failed to toggle Cursor MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                callJavaScript("window.showError", escapeJs("切换 Cursor MCP 服务器失败: " + e.getMessage()))
            );
        }
    }

    private List<JsonObject> parseServersFromListOutput(List<String> lines) {
        List<JsonObject> servers = new ArrayList<>();
        for (String line : lines) {
            Matcher matcher = SERVER_STATUS_PATTERN.matcher(line);
            if (!matcher.matches()) {
                continue;
            }
            String id = matcher.group(1).trim();
            String statusRaw = matcher.group(2).trim();

            JsonObject server = new JsonObject();
            server.addProperty("id", id);
            server.addProperty("name", id);
            server.addProperty("enabled", !isDisabledStatus(statusRaw));
            server.addProperty("description", "Managed by Cursor CLI");

            JsonObject spec = new JsonObject();
            spec.addProperty("command", "cursor-agent mcp");
            server.add("server", spec);

            servers.add(server);
        }
        return servers;
    }

    private List<JsonObject> parseStatusFromListOutput(List<String> lines) {
        List<JsonObject> statuses = new ArrayList<>();
        for (String line : lines) {
            Matcher matcher = SERVER_STATUS_PATTERN.matcher(line);
            if (!matcher.matches()) {
                continue;
            }
            String id = matcher.group(1).trim();
            String statusRaw = matcher.group(2).trim();

            JsonObject status = new JsonObject();
            status.addProperty("name", id);
            status.addProperty("status", mapCursorStatus(statusRaw));
            statuses.add(status);
        }
        return statuses;
    }

    private JsonArray parseToolsFromListToolsOutput(List<String> lines) {
        JsonArray tools = new JsonArray();
        int expectedToolCount = -1;
        for (String line : lines) {
            Matcher headerMatcher = TOOLS_HEADER_PATTERN.matcher(line);
            if (headerMatcher.matches()) {
                try {
                    expectedToolCount = Integer.parseInt(headerMatcher.group(1));
                } catch (Exception ignored) {
                    expectedToolCount = -1;
                }
                continue;
            }

            Matcher matcher = TOOL_PATTERN.matcher(line);
            if (!matcher.matches()) {
                matcher = TOOL_INDEXED_PATTERN.matcher(line);
                if (!matcher.matches()) {
                    continue;
                }
            }

            String toolName = matcher.group(1).trim();
            String argsPart = matcher.group(2) != null ? matcher.group(2).trim() : "";

            JsonObject tool = new JsonObject();
            tool.addProperty("name", toolName);
            if (!argsPart.isEmpty()) {
                tool.addProperty("description", "Args: " + argsPart);
                JsonObject schema = new JsonObject();
                JsonObject properties = new JsonObject();
                for (String arg : argsPart.split(",")) {
                    String argName = arg.trim();
                    if (argName.isEmpty()) {
                        continue;
                    }
                    JsonObject argSchema = new JsonObject();
                    argSchema.addProperty("type", "string");
                    properties.add(argName, argSchema);
                }
                schema.add("properties", properties);
                tool.add("inputSchema", schema);
            }
            tools.add(tool);
        }
        if (expectedToolCount > 0 && tools.size() == 0) {
            LOG.warn("[CursorMcpServerHandler] Tools header indicates " + expectedToolCount + " tools but parsed 0. Raw lines: " + lines);
        }
        return tools;
    }

    private String mapCursorStatus(String rawStatus) {
        String normalized = rawStatus.toLowerCase();
        if (normalized.contains("ready") || normalized.contains("enabled")) {
            return "connected";
        }
        if (normalized.contains("auth")) {
            return "needs-auth";
        }
        if (normalized.contains("pending") || normalized.contains("loading") || normalized.contains("starting")) {
            return "pending";
        }
        if (normalized.contains("failed") || normalized.contains("error") || normalized.contains("invalid")) {
            return "failed";
        }
        if (normalized.contains("disabled")) {
            return "pending";
        }
        return "unknown";
    }

    private boolean isDisabledStatus(String rawStatus) {
        return rawStatus.toLowerCase().contains("disabled");
    }

    private String getProjectBasePath() {
        return context.getProject() != null ? context.getProject().getBasePath() : null;
    }

    private boolean isNotApprovedError(String error) {
        if (error == null) {
            return false;
        }
        String normalized = error.toLowerCase().replaceAll("\\s+", " ").trim();
        return normalized.contains("has not been approved");
    }

    private boolean isNotApprovedLines(List<String> lines) {
        if (lines == null || lines.isEmpty()) {
            return false;
        }
        String merged = String.join(" ", lines);
        return isNotApprovedError(merged);
    }

    private boolean isNotApprovedResult(CommandResult result) {
        if (result == null) {
            return false;
        }
        if (isNotApprovedError(result.error)) {
            return true;
        }
        return isNotApprovedLines(result.lines);
    }

    private CommandResult retryAfterEnable(String serverId, String cwd, CommandResult originalResult) {
        CommandResult enableResult = runCursorMcpCommand(List.of("enable", serverId), cwd);
        if (!enableResult.success && !isAlreadyEnabledMessage(enableResult)) {
            return CommandResult.failure(enableResult.error != null ? enableResult.error : "Failed to enable MCP server before listing tools");
        }
        CommandResult retried = runCursorMcpCommand(List.of("list-tools", serverId), cwd);
        if (!retried.success && originalResult != null && originalResult.error != null) {
            return CommandResult.failure(retried.error != null ? retried.error : originalResult.error);
        }
        return retried;
    }

    private boolean isAlreadyEnabledMessage(CommandResult result) {
        if (result == null) {
            return false;
        }
        if (result.error != null) {
            String msg = result.error.toLowerCase().replaceAll("\\s+", " ").trim();
            if (msg.contains("already enabled")) {
                return true;
            }
        }
        if (result.lines != null && !result.lines.isEmpty()) {
            String merged = String.join(" ", result.lines).toLowerCase().replaceAll("\\s+", " ").trim();
            return merged.contains("already enabled");
        }
        return false;
    }

    private String sanitizeCliLine(String rawLine) {
        if (rawLine == null) {
            return "";
        }

        // 去 ANSI 转义序列（颜色、光标移动等）
        String cleaned = ANSI_ESCAPE_PATTERN.matcher(rawLine).replaceAll("");
        // 去不可见控制字符
        cleaned = cleaned.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", "");
        // 去进度条残留前缀（如 [2K[1A[2K[G）
        cleaned = LEADING_PROGRESS_GARBAGE.matcher(cleaned).replaceFirst("");
        while (cleaned.startsWith("[G")) {
            cleaned = cleaned.substring(2);
        }
        return cleaned.trim();
    }

    private CommandResult runCursorMcpCommand(List<String> mcpArgs, String cwd) {
        List<String> command = new ArrayList<>();
        command.add("cursor-agent");
        command.add("mcp");
        command.addAll(mcpArgs);

        Process process = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.redirectErrorStream(true);
            pb.environment().put("TERM", "dumb");
            pb.environment().put("NO_COLOR", "1");
            pb.environment().put("CI", "1");

            if (cwd != null && !cwd.isBlank()) {
                java.io.File dir = new java.io.File(cwd);
                if (dir.exists() && dir.isDirectory()) {
                    pb.directory(dir);
                }
            }

            process = pb.start();

            List<String> lines = new ArrayList<>();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String sanitized = sanitizeCliLine(line);
                    if (!sanitized.isEmpty()) {
                        lines.add(sanitized);
                    }
                }
            }

            boolean finished = process.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return CommandResult.failure("cursor-agent mcp command timeout");
            }

            int exitCode = process.exitValue();
            if (exitCode != 0) {
                return CommandResult.failure(lines.isEmpty() ? ("cursor-agent mcp exited with code " + exitCode) : String.join("\n", lines));
            }

            return CommandResult.success(lines);
        } catch (Exception e) {
            return CommandResult.failure(e.getMessage());
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private static class CommandResult {
        private final boolean success;
        private final List<String> lines;
        private final String error;

        private CommandResult(boolean success, List<String> lines, String error) {
            this.success = success;
            this.lines = lines;
            this.error = error;
        }

        static CommandResult success(List<String> lines) {
            return new CommandResult(true, lines, null);
        }

        static CommandResult failure(String error) {
            return new CommandResult(false, List.of(), error);
        }
    }
}
