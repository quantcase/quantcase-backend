const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const createAccessRequest = async (req, res) => {
  try {
    const { name, profession, email, mobileNumber, incomeLevel } = req.body;

    if (!name || !profession || !email || !incomeLevel) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const accessRequest = await prisma.accessRequest.create({
      data: {
        name,
        profession,
        email,
        mobileNumber: mobileNumber || null,
        incomeLevel,
      },
    });

    res.status(201).json({ message: 'Request recorded successfully', data: accessRequest });
  } catch (error) {
    console.error('Error creating access request:', error);
    res.status(500).json({ error: 'Failed to record access request' });
  }
};

module.exports = {
  createAccessRequest,
};
