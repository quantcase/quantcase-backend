const { Queue } = require('bullmq');
const Redis = require('ioredis');

/**
 * JobQueue Singleton
 * Manages BullMQ queues backed only by Redis (no Postgres Job table).
 */
class JobQueue {
  constructor() {
    if (JobQueue.instance) {
      return JobQueue.instance;
    }

    // Initialize Redis connection
    this.connection = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 20000);
        return delay;
      }
    });

    // Initialize queues
    this.queues = {};

    JobQueue.instance = this;
  }

  /**
   * Get or create a queue by name
   * @param {string} queueName - Name of the queue
   * @returns {Queue} BullMQ Queue instance
   */
  getQueue(queueName) {
    if (!this.queues[queueName]) {
      this.queues[queueName] = new Queue(queueName, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: {
            age: 7 *24 * 3600, // Keep completed jobs for 24 hours
            count: 25000
          },
          removeOnFail: {
            age: 7 * 24 * 3600 // Keep failed jobs for 7 days
          }
        }
      });
    }
    return this.queues[queueName];
  }

  /**
   * Add a job to the queue
   * @param {string} queueName - Name of the queue
   * @param {object} jobData - Job data to be processed
   * @param {object} options - Additional BullMQ job options
   * @returns {Promise<object>} BullMQ job object
   */
  async addJob(queueName, jobData, options = {}) {
    const queue = this.getQueue(queueName);
    const bullmqJob = await queue.add(
      jobData.type || 'default',
      jobData,
      options
    );
    console.log(`BullMQ job created: ${bullmqJob.id} in queue: ${queueName}`);
    return bullmqJob;
  }

  /**
   * Get job status from BullMQ
   * @param {string} queueName - Name of the queue
   * @param {string} jobId - BullMQ job ID
   * @returns {Promise<object|null>} Job state and details
   */
  async getJobStatus(queueName, jobId) {
    const queue = this.getQueue(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      return null;
    }

    const state = await job.getState();

    return {
      id: job.id,
      name: job.name,
      state,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      data: job.data
    };
  }

  /**
   * Close all connections
   */
  async close() {
    console.log('Closing JobQueue connections...');
    for (const queueName in this.queues) {
      await this.queues[queueName].close();
    }
    await this.connection.quit();
    console.log('JobQueue connections closed');
  }
}

// Create and export singleton instance
const jobQueueInstance = new JobQueue();

module.exports = jobQueueInstance;
