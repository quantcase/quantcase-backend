'use strict';

const prisma = require('../config/prisma');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const CATEGORIES = ['bug', 'data_issue', 'performance', 'ui_ux', 'login_auth', 'payment_billing', 'other'];
const STATUSES = ['open', 'in_progress', 'resolved', 'wont_fix'];

async function createErrorReport({ userId, userEmail, category, message, pageUrl, errorMessage, userAgent, metadata }) {
  const report = await prisma.errorReport.create({
    data: {
      user_id: userId || null,
      user_email: userEmail || null,
      category: category || 'other',
      message,
      page_url: pageUrl || null,
      error_message: errorMessage || null,
      user_agent: userAgent || null,
      metadata: metadata || undefined,
    },
  });
  return report;
}

async function listErrorReports({ page, size, status, category }) {
  const where = {};
  if (status) where.status = status;
  if (category) where.category = category;

  const [total, data] = await Promise.all([
    prisma.errorReport.count({ where }),
    prisma.errorReport.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * size,
      take: size,
      include: { user: { select: { id: true, email: true, display_name: true } } },
    }),
  ]);

  return { data, pagination: { page, size, total, totalPages: Math.ceil(total / size) } };
}

async function getErrorReportById(id) {
  const report = await prisma.errorReport.findUnique({
    where: { id },
    include: { user: { select: { id: true, email: true, display_name: true } } },
  });
  if (!report) throw new HttpError(404, 'Error report not found');
  return report;
}

async function updateErrorReport(id, { status, adminNotes }) {
  await getErrorReportById(id);

  const data = {};
  if (status !== undefined) data.status = status;
  if (adminNotes !== undefined) data.admin_notes = adminNotes;

  return prisma.errorReport.update({ where: { id }, data });
}

module.exports = {
  createErrorReport,
  listErrorReports,
  getErrorReportById,
  updateErrorReport,
  CATEGORIES,
  STATUSES,
  HttpError,
};
