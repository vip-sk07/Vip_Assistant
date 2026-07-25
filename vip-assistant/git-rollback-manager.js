import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Git Checkpoint & Automated AI Rollback Manager
 * Provides automated snapshots before AI edits and 1-click workspace rollbacks.
 */
export class GitRollbackManager {
  constructor(workspaceDir) {
    this.workspaceDir = workspaceDir;
    this.checkpointStack = [];
  }

  /**
   * Creates an automated pre-edit checkpoint
   */
  async createCheckpoint(actionDescription = 'AI Edit Snapshot') {
    try {
      // Check if git is initialized
      const isGit = await fs.access(path.join(this.workspaceDir, '.git')).then(() => true).catch(() => false);
      if (!isGit) return null;

      // Stash current changes or record stash ref
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stashMessage = `VIP_CHECKPOINT_${timestamp}_${actionDescription.replace(/\s+/g, '_')}`;

      await execAsync(`git stash create`, { cwd: this.workspaceDir }).then(async ({ stdout }) => {
        const hash = stdout.trim();
        if (hash) {
          await execAsync(`git stash store -m "${stashMessage}" ${hash}`, { cwd: this.workspaceDir });
          this.checkpointStack.push({
            hash,
            message: stashMessage,
            timestamp: new Date().toISOString()
          });
          if (this.checkpointStack.length > 30) {
            this.checkpointStack.shift();
          }
          console.log(`[GitRollback] Created checkpoint: ${hash.substring(0, 7)} - ${actionDescription}`);
        }
      }).catch(() => {});
    } catch (err) {
      console.warn('[GitRollback] Failed to create checkpoint:', err.message);
    }
  }

  /**
   * Rollback workspace to the last pre-edit checkpoint
   */
  async rollbackLastCheckpoint() {
    try {
      const isGit = await fs.access(path.join(this.workspaceDir, '.git')).then(() => true).catch(() => false);
      if (!isGit) {
        return { success: false, message: 'Git repository is not initialized in workspace.' };
      }

      if (this.checkpointStack.length === 0) {
        // Fallback to git checkout .
        await execAsync('git checkout .', { cwd: this.workspaceDir });
        return { success: true, message: 'Reverted all modified files to last git commit.' };
      }

      const checkpoint = this.checkpointStack.pop();
      await execAsync(`git stash apply ${checkpoint.hash}`, { cwd: this.workspaceDir });
      return { success: true, message: `Successfully rolled back to checkpoint (${checkpoint.hash.substring(0, 7)}).` };
    } catch (err) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }

  /**
   * Returns list of recent checkpoints
   */
  getHistory() {
    return [...this.checkpointStack];
  }
}
