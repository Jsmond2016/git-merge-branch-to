import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { getGitProjectName } from './utils';

const CANCEL = '退出操作';
const COMMAND_ID = 'gitMergeBranchTo.merge-branch-to';

type WorktreeFlowOptions = {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
};

type DeployUrlConfig = {
  env: string;
  defaultBranch?: string;
  autoTriggleFlow?: boolean;
  delayTriggleTime?: number;
  webUrl?: string;
  serverWebhookMap?: Record<
    string,
    {
      hookUrl?: string;
      webUrl?: string;
    }
  >;
};

function runGitCommand(command: string): string {
  return execSync(command, {
    stdio: 'pipe',
    maxBuffer: 1024 * 1024 * 10,
  }).toString();
}

function getWorkspaceRootPath(): string {
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rootPath) {
    throw new Error('当前窗口未打开工作区');
  }
  return rootPath;
}

async function workTreeFlows({
  repoPath,
  sourceBranch,
  targetBranch,
}: WorktreeFlowOptions): Promise<boolean> {
  let isMergeSuccess = false;

  await vscode.window
    .withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '后台合并分支中...',
        cancellable: false,
      },
      async (progress) => {
        const randomId = crypto.randomBytes(8).toString('hex');
        const worktreePath = `${os.tmpdir()}/vscode-merge-${targetBranch}-${randomId}`;

        progress.report({ message: '创建临时工作区...' });
        try {
          runGitCommand(
            `git -C "${repoPath}" worktree add --detach "${worktreePath}"`
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`创建临时工作区失败: ${message}`);
          return;
        }

        try {
          progress.report({ message: '获取最新分支信息...' });
          runGitCommand(`git -C "${worktreePath}" fetch origin`);

          progress.report({ message: '切换到目标分支...' });
          runGitCommand(
            `git -C "${worktreePath}" checkout --detach "origin/${targetBranch}"`
          );

          progress.report({ message: '合并分支...' });
          try {
            runGitCommand(
              `git -C "${worktreePath}" merge --no-ff --no-verify "${sourceBranch}" -m "Merge ${sourceBranch} into ${targetBranch}"`
            );
          } catch (error) {
            const status = runGitCommand(`git -C "${worktreePath}" status`);
            if (
              status.includes('Unmerged paths') ||
              status.includes('CONFLICT')
            ) {
              void vscode.window.showErrorMessage(
                `合并分支失败 ${sourceBranch} -> ${targetBranch}. 存在代码冲突，请手动处理。`
              );
            } else {
              const message =
                error instanceof Error ? error.message : String(error);
              void vscode.window.showErrorMessage(
                `合并分支失败 ${sourceBranch} -> ${targetBranch}. ${message}`
              );
            }
            throw error;
          }

          progress.report({ message: '推送到远程...' });
          runGitCommand(
            `git -C "${worktreePath}" push origin "HEAD:${targetBranch}"`
          );

          isMergeSuccess = true;

          void vscode.window.showInformationMessage(
            `✅ 合并分支 ${sourceBranch} -> ${targetBranch} 成功（后台执行）`
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!message.includes('合并分支失败')) {
            void vscode.window.showErrorMessage(`操作失败: ${message}`);
          }
        } finally {
          progress.report({ message: '清理临时文件...' });
          try {
            runGitCommand(
              `git -C "${repoPath}" worktree remove "${worktreePath}" --force`
            );
          } catch {
            try {
              fs.rmSync(worktreePath, { recursive: true, force: true });
            } catch (cleanupError) {
              console.error('清理临时目录失败:', cleanupError);
            }
          }
        }

        progress.report({ message: '完成' });
      }
    );

  return isMergeSuccess;
}

function getDeployUrlConfigs(): DeployUrlConfig[] {
  const config = vscode.workspace.getConfiguration('gitMergeBranchTo');
  const deployConfig = config.get<{ urlConfig?: DeployUrlConfig[] }>(
    'deployConfig'
  );
  return deployConfig?.urlConfig ?? [];
}

async function triggerWebhookForEnv(envConfig: DeployUrlConfig): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitMergeBranchTo');
  const projectName = await getGitProjectName();
  if (!projectName) {
    void vscode.window.showErrorMessage(
      '未找到当前项目名, 请确保当前项目目录存在git仓库内'
    );
    return;
  }

  const projectWebhookConfig = envConfig?.serverWebhookMap?.[projectName];
  if (!envConfig || !projectWebhookConfig?.hookUrl) {
    void vscode.window.showErrorMessage(`未找到 ${projectName} 的配置信息`);
    return;
  }

  const webhookUrl = projectWebhookConfig.hookUrl;
  const webUrl = projectWebhookConfig.webUrl ?? envConfig.webUrl;
  const feishuId = config.get<string>('feishuId');
  const branch = envConfig.defaultBranch;
  const data = JSON.stringify({ feishuId, branch });

  try {
    runGitCommand(
      `curl --header "Content-Type: application/json" --request POST --data '${data}' ${webhookUrl}`
    );

    if (webUrl) {
      const selection = await vscode.window.showInformationMessage(
        `✅ 触发 webhook 成功`,
        '查看流水线'
      );
      if (selection === '查看流水线') {
        await vscode.env.openExternal(vscode.Uri.parse(webUrl));
      }
      return;
    }

    void vscode.window.showInformationMessage(`✅ 触发 webhook 成功`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`触发 webhook 失败: ${message}`);
  }
}

async function triggerWebhooks(): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitMergeBranchTo');
  const urlConfigs = getDeployUrlConfigs();
  const branches = config.get<string[]>('branches') ?? [];

  if (!urlConfigs.length || !branches.length) {
    return;
  }

  const envList = urlConfigs.map((item) => item.env);
  const selectedEnv = await vscode.window.showQuickPick([CANCEL, ...envList], {
    canPickMany: false,
    placeHolder: '选择要触发webhook的环境',
  });

  if (!selectedEnv || selectedEnv === CANCEL) {
    return;
  }

  const envConfig = urlConfigs.find((item) => item.env === selectedEnv);
  if (!envConfig) {
    return;
  }

  await triggerWebhookForEnv(envConfig);
}

function getAutoTriggerEnvConfig(
  targetBranch: string
): DeployUrlConfig | undefined {
  return getDeployUrlConfigs().find(
    (item) => item.defaultBranch === targetBranch && item.autoTriggleFlow
  );
}

function getDelayTriggerTime(envConfig: DeployUrlConfig): number {
  if (
    typeof envConfig.delayTriggleTime !== 'number' ||
    Number.isNaN(envConfig.delayTriggleTime)
  ) {
    return 6;
  }

  return Math.max(0, Math.floor(envConfig.delayTriggleTime));
}

async function startAutoTriggerCountdown(
  targetBranch: string,
  envConfig: DeployUrlConfig
): Promise<void> {
  let secondsRemaining = getDelayTriggerTime(envConfig);
  let isCancelled = false;

  if (secondsRemaining === 0) {
    await triggerWebhookForEnv(envConfig);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `代码合并到 ${targetBranch} 成功，将在 ${secondsRemaining}s 内自动触发 ${envConfig.env} 构建流程`,
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => {
        isCancelled = true;
      });

      while (secondsRemaining > 0 && !isCancelled) {
        progress.report({
          message: `${secondsRemaining}s 后自动触发 ${envConfig.env} 构建流程，点击取消可终止`,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        secondsRemaining -= 1;
      }
    }
  );

  if (isCancelled) {
    void vscode.window.showInformationMessage(
      `已取消自动触发 ${envConfig.env} 构建流程`
    );
    return;
  }

  await triggerWebhookForEnv(envConfig);
}

function getCurrentBranchName(): string {
  const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
  const gitApi = gitExtension?.getAPI(1);
  const workspaceRoot = getWorkspaceRootPath();
  const repository = gitApi?.repositories.find(
    (repo: { rootUri: vscode.Uri }) => {
      return repo.rootUri.fsPath === workspaceRoot;
    }
  );

  const branchName = repository?.state.HEAD?.name;
  if (!branchName) {
    throw new Error('当前仓库无法识别');
  }

  return branchName;
}

async function execFlow(targetBranch: string): Promise<void> {
  const sourceBranch = getCurrentBranchName();
  const repoPath = getWorkspaceRootPath();
  const isMergeSuccess = await workTreeFlows({
    repoPath,
    targetBranch,
    sourceBranch,
  });

  if (!isMergeSuccess) {
    return;
  }

  const autoTriggerEnvConfig = getAutoTriggerEnvConfig(targetBranch);
  if (autoTriggerEnvConfig) {
    await startAutoTriggerCountdown(targetBranch, autoTriggerEnvConfig);
    return;
  }

  await triggerWebhooks();
}

async function manageWorktrees(): Promise<void> {
  const config = vscode.workspace.getConfiguration('gitMergeBranchTo');
  const branches = config.get<string[]>('branches');

  if (!branches?.length) {
    const sourceBranch = getCurrentBranchName();
    const targetBranch = sourceBranch.replace('feature/', 'release/');
    const rootPath = getWorkspaceRootPath();
    const isExistRemoteTargetBranch = runGitCommand(
      `git -C "${rootPath}" ls-remote --heads origin ${targetBranch}`
    );

    if (!isExistRemoteTargetBranch) {
      try {
        runGitCommand(
          `git -C "${rootPath}" branch ${targetBranch} origin/master`
        );
        runGitCommand(`git -C "${rootPath}" push origin ${targetBranch}`);
        void vscode.window.showInformationMessage(
          `已创建远程分支 ${targetBranch} 并推送到远端`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(
          `创建分支 ${targetBranch} 失败: ${message}`
        );
        return;
      }
    }

    void execFlow(targetBranch);
    return;
  }

  const targetBranch = await vscode.window.showQuickPick(branches, {
    canPickMany: false,
    placeHolder: '选择你要合并到哪个分支',
  });

  if (!targetBranch || targetBranch === CANCEL) {
    return;
  }

  void execFlow(targetBranch);
}

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(
    COMMAND_ID,
    manageWorktrees
  );
  context.subscriptions.push(disposable);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = COMMAND_ID;
  statusBarItem.text = '$(git-branch) 合并分支到';
  statusBarItem.tooltip = '合并分支到指定分支';
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);
}

export function deactivate(): void {
  // VS Code 会自动清理 context.subscriptions 中的资源。
}
