'use strict';

function requestAccessEmail({ name, email }) {
  const subject = "We've received your request to join QuantCase";

  const html = `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Helvetica,Arial,sans-serif;">
    <!-- Hidden preview text shown by some email clients -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Your request to join QuantCase has been received.
    </div>

    <table
      role="presentation"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      style="background-color:#f4f4f7;padding:32px 16px;"
    >
      <tr>
        <td align="center">
          <table
            role="presentation"
            width="100%"
            cellpadding="0"
            cellspacing="0"
            style="width:100%;max-width:480px;background-color:#ffffff;border-radius:8px;overflow:hidden;"
          >
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827;">
                  We've received your request
                </h1>

                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">
                  Hi ${name},
                </p>

                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">
                  Thanks for your interest in quantcase. We've received your request for access to our beta.
                </p>

                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#374151;">
                  Our team will review your request and contact you at
                  <strong style="color:#111827;">${email}</strong>
                  when access becomes available.
                </p>

                <table
                  role="presentation"
                  width="100%"
                  cellpadding="0"
                  cellspacing="0"
                  style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;"
                >
                  <tr>
                    <td style="padding:16px;">
                      <p style="margin:0 0 4px;font-size:12px;color:#6b7280;">
                        Request status
                      </p>

                      <p style="margin:0;font-size:14px;font-weight:bold;color:#111827;">
                        Received and awaiting review
                      </p>
                    </td>
                  </tr>
                </table>

                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  You don't need to take any further action. If you didn't submit this request, you can safely ignore this email.
                </p>

                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  - The quantcase team
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

  const text = `Hi ${name},\n\nThanks for your interest in QuantCase. We've received your request for access to our beta.\n\nOur team will review your request and contact you at ${email} when access becomes available.\n\n- The quantcase team`;

  return { subject, html, text };
}

module.exports = { requestAccessEmail };
