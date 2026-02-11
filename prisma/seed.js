const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('Starting database seed...');

  // Create sample calls
  const call1 = await prisma.call.create({
    data: {
      title: 'Sample Call 1',
      description: 'This is a sample call recording',
      audioUrl: 'https://example.com/audio1.mp3',
      duration: 180,
      status: 'completed'
    }
  });

  const call2 = await prisma.call.create({
    data: {
      title: 'Sample Call 2',
      description: 'Another sample call recording',
      audioUrl: 'https://example.com/audio2.mp3',
      duration: 240,
      status: 'pending'
    }
  });

  console.log('Created calls:', { call1, call2 });

  // Create sample jobs
  const job1 = await prisma.job.create({
    data: {
      callId: call1.id,
      type: 'summarization',
      status: 'completed',
      result: {
        summary: 'This is a summary of the first call',
        keyPoints: ['Point 1', 'Point 2', 'Point 3']
      }
    }
  });

  const job2 = await prisma.job.create({
    data: {
      callId: call2.id,
      type: 'summarization',
      status: 'pending'
    }
  });

  console.log('Created jobs:', { job1, job2 });
  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
