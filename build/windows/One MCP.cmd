@echo off
setlocal DisableDelayedExpansion
rem One's MCP server over stdio, for MCP clients (LM Studio, Codex CLI, Claude) and for WSL:
rem   cmd.exe /c "C:\Apps\One\One MCP.cmd"
rem It prints nothing itself: stdout belongs to the protocol. Switch it on first: One - Settings - MCP server.
rem Extra arguments pass through, e.g.  "One MCP.cmd" --folder notes --read-only
rem Runs in One.exe itself, without a window - no Node.js install needed.
"%~dp0One.exe" --mcp-stdio %*
