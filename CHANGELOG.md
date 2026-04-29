# Change Log

All notable changes to the "merge-code" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.3.4] - 2026-04-29

### Added
- `deployConfig.urlConfig` 新增 `autoTriggleFlow` 配置，默认 `false`
- `deployConfig.urlConfig` 新增 `delayTriggleTime` 配置，单位秒，默认 `6`
- 合并成功后支持按目标分支自动匹配环境并显示倒计时提示

### Changed
- 仅在代码合并和推送成功后才继续执行部署触发流程
- 当 `autoTriggleFlow` 为 `true` 时，匹配到的环境会在倒计时结束后自动触发 webhook
- 当 `delayTriggleTime` 为 `0` 时，跳过倒计时立即触发 webhook
- 未开启自动触发时，保持原有手动选择环境的行为

## [1.2.2] - 2025-11-28

### 🚀 Major Performance Improvement
- **Optimized worktree approach**: Uses temporary worktree in system temp directory with `--detach` flag
- **Background execution**: Merge operations happen in isolated worktree, no impact on current workspace
- **Zero interruption**: Developers can continue working without branch switching or file changes
- **Eliminates**: Copying working files and node_modules (only creates minimal .git directory)
- **Result**: Fast, non-blocking merge operations with no editor impact

### Fixed
- **Critical**: Fixed memory leak caused by `withProgress` not returning Promise
- **Critical**: Fixed editor freezing issue caused by worktree copying node_modules and large files
- **Critical**: Fixed massive disk I/O that triggered VSCode file watchers and froze ESLint/TypeScript
- **Critical UX Bug**: Fixed progress notification blocking webhook selection dialog
- Fixed webhook success message to show clickable button instead of non-working Markdown link
- Fixed async operations not being properly awaited in `triggerWebhooks`
- Fixed variable naming conflict in `triggerWebhooks` function
- Webhook selection now appears after progress notification closes
- Users can now clearly see and interact with the webhook environment selection
- Now shows "查看流水线" button that can be clicked to open pipeline URL

### Changed
- **New approach**: Temporary worktree in system temp directory (isolated from workspace)
- Uses `git worktree add --detach` to create minimal worktree without checking out files
- Worktree created in `/tmp` directory, avoiding VSCode file watchers
- All `execSync` calls now use `stdio: "pipe"` with 10MB buffer limit
- `triggerWebhooks` function converted to async/await pattern for better error handling
- Moved `triggerWebhooks()` call to after `withProgress` completes
- Automatic cleanup of temporary worktree after operation
- Better error handling with conflict detection
- Improved webhook success notification with proper button interaction
- Better visual feedback when webhook is triggered
- Improved user experience: progress → success message → webhook selection

### Performance
- **Dramatically** reduced disk I/O (minimal worktree, no working files copied)
- **Dramatically** reduced memory usage (temp directory not monitored by VSCode)
- **Zero impact** on current workspace (no branch switching, no file changes)
- Eliminated editor lag when merging branches
- Fixed ESLint and TypeScript services freezing
- Developers can continue working during merge operations
