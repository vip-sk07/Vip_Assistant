import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Background Task & Cron Scheduler Engine
 * Schedules one-shot timers and recurring tasks (tests, git sync, telemetry checks).
 */
export class CronSchedulerEngine {
  constructor() {
    this.tasks = new Map(); // id -> { id, prompt, intervalMs, lastRun, timerId, runCount, isRecurring }
  }

  /**
   * Schedules a one-shot timer or recurring background task
   */
  scheduleTask(id, prompt, command, delaySeconds, isRecurring = false, onNotify = null) {
    if (this.tasks.has(id)) {
      this.cancelTask(id);
    }

    const intervalMs = Math.max(1000, delaySeconds * 1000);
    const taskInfo = {
      id,
      prompt,
      command,
      intervalMs,
      isRecurring,
      lastRun: null,
      runCount: 0,
      timerId: null
    };

    const runExecution = async () => {
      taskInfo.lastRun = new Date().toISOString();
      taskInfo.runCount++;

      let output = '';
      let isError = false;

      if (command) {
        try {
          const { stdout } = await execAsync(command);
          output = stdout;
        } catch (err) {
          output = err.stderr || err.stdout || err.message;
          isError = true;
        }
      }

      if (onNotify && typeof onNotify === 'function') {
        onNotify({
          taskId: id,
          prompt,
          command,
          output,
          isError,
          runCount: taskInfo.runCount,
          timestamp: taskInfo.lastRun
        });
      }

      if (!isRecurring) {
        this.cancelTask(id);
      }
    };

    if (isRecurring) {
      taskInfo.timerId = setInterval(runExecution, intervalMs);
    } else {
      taskInfo.timerId = setTimeout(runExecution, intervalMs);
    }

    this.tasks.set(id, taskInfo);
    console.log(`[CronScheduler] Scheduled task '${id}' (Recurring: ${isRecurring}, Interval: ${delaySeconds}s)`);
    return taskInfo;
  }

  /**
   * Cancels a running task
   */
  cancelTask(id) {
    if (!this.tasks.has(id)) return false;
    const task = this.tasks.get(id);
    if (task.timerId) {
      if (task.isRecurring) {
        clearInterval(task.timerId);
      } else {
        clearTimeout(task.timerId);
      }
    }
    this.tasks.delete(id);
    console.log(`[CronScheduler] Cancelled task '${id}'`);
    return true;
  }

  /**
   * Lists all scheduled tasks
   */
  listTasks() {
    const list = [];
    for (const [id, task] of this.tasks.entries()) {
      list.push({
        id,
        prompt: task.prompt,
        command: task.command,
        intervalSeconds: Math.round(task.intervalMs / 1000),
        isRecurring: task.isRecurring,
        lastRun: task.lastRun,
        runCount: task.runCount
      });
    }
    return list;
  }

  /**
   * Clears all tasks
   */
  clearAll() {
    for (const id of this.tasks.keys()) {
      this.cancelTask(id);
    }
  }
}
