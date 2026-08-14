const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { sendMail } = require('../lib/mailer');
const { requestAccessEmail } = require('../utils/emailTemplates/requestAccess');

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

    try {
      const { subject, html, text } = requestAccessEmail({ name, email });
      await sendMail({ to: email, subject, html, text });
    } catch (mailError) {
      console.error('Error sending access request email:', mailError);
      // We don't fail the request if the email fails to send, but log it
    }

    res.status(201).json({ message: 'Request recorded successfully', data: accessRequest });
  } catch (error) {
    console.error('Error creating access request:', error);
    res.status(500).json({ error: 'Failed to record access request' });
  }
};

module.exports = {
  createAccessRequest,
};
