const { Queue } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');

/**
 * JobQueue Singleton
 * Manages BullMQ queues and database job entries
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

    // Initialize Prisma Client
    this.prisma = new PrismaClient();

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
          attempts: 4,
          backoff: {
            type: 'fixed',
            delay: 20000
          },
          removeOnComplete: {
            age: 24 * 3600, // Keep completed jobs for 24 hours
            count: 1000
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
   * Add a job to the queue and create database entry
   * @param {string} queueName - Name of the queue
   * @param {object} jobData - Job data to be processed
   * @param {object} options - Additional options for job creation
   * @returns {Promise<object>} Created database job entry
   */
  async addJob(queueName, jobData, options = {}) {
    let bullmqJob = null;
    try {
      // Get the queue
      const queue = this.getQueue(queueName);

      // Add job to BullMQ
      bullmqJob = await queue.add(
        jobData.type || 'default',
        jobData,
        {
          jobId: options.jobId,
          priority: options.priority,
          delay: options.delay,
          ...options
        }
      );

      console.log(`BullMQ job created: ${bullmqJob.id} in queue: ${queueName}`);

      // Create database entry with BullMQ job ID
      const dbJob = await this.prisma.job.create({
        data: {
          callId: jobData.callId,
          type: jobData.type,
          status: 'pending',
          bullmqId: bullmqJob.id
        }
      });

      console.log(`Database job entry created: ${dbJob.id}`);

      return dbJob;
    } catch (error) {
      console.error('Error adding job:', error);

      // If database creation failed but BullMQ job was created, try to remove it
      if (bullmqJob && error.code !== 'P2002') { // P2002 is unique constraint violation
        try {
          await bullmqJob.remove();
          console.log(`Removed orphaned BullMQ job: ${bullmqJob.id}`);
        } catch (removeError) {
          console.error('Failed to remove orphaned BullMQ job:', removeError);
        }
      }

      throw error;
    }
  }

  /**
   * Get job status from BullMQ
   * @param {string} queueName - Name of the queue
   * @param {string} bullmqId - BullMQ job ID
   * @returns {Promise<object>} Job state and details
   */
  async getJobStatus(queueName, bullmqId) {
    try {
      const queue = this.getQueue(queueName);
      const job = await queue.getJob(bullmqId);

      if (!job) {
        return null;
      }

      const state = await job.getState();
      const progress = job.progress;

      return {
        id: job.id,
        name: job.name,
        data: job.data,
        state,
        progress,
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        returnvalue: job.returnvalue,
        failedReason: job.failedReason
      };
    } catch (error) {
      console.error('Error getting job status:', error);
      throw error;
    }
  }

  /**
   * Update database job status based on BullMQ job state
   * @param {string} jobId - Database job ID
   * @param {object} updates - Updates to apply
   * @returns {Promise<object>} Updated job
   */
  async updateJobStatus(jobId, updates) {
    try {
      return await this.prisma.job.update({
        where: { id: jobId },
        data: {
          ...updates,
          updatedAt: new Date()
        }
      });
    } catch (error) {
      console.error('Error updating job status:', error);
      throw error;
    }
  }

  /**
   * Close all connections
   */
  async close() {
    console.log('Closing JobQueue connections...');

    // Close all queues
    for (const queueName in this.queues) {
      await this.queues[queueName].close();
    }

    // Close Redis connection
    await this.connection.quit();

    // Close Prisma connection
    await this.prisma.$disconnect();

    console.log('JobQueue connections closed');
  }
}

// Create and export singleton instance
const jobQueueInstance = new JobQueue();

module.exports = jobQueueInstance;
