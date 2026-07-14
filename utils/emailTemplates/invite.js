'use strict';

function inviteEmail({ inviteUrl }) {
  const subject = "You're invited to QuantCase";

  const html = `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;color:#111827;">You're invited to QuantCase</h1>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#374151;">
                  You've been invited to join the QuantCase beta. Click the button below to create your account and get access to the dashboard.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:6px;background-color:#111827;">
                      <a href="${inviteUrl}" style="display:inline-block;padding:12px 24px;font-size:14px;color:#ffffff;text-decoration:none;font-weight:bold;">
                        Join QuantCase
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  Or copy and paste this link into your browser:<br>
                  <a href="${inviteUrl}" style="color:#6b7280;word-break:break-all;">${inviteUrl}</a>
                </p>
                <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  This invite link will expire in 7 days.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

  const text = `You're invited to QuantCase.\n\nJoin here: ${inviteUrl}\n\nThis invite link will expire in 7 days.`;

  return { subject, html, text };
}

module.exports = { inviteEmail };
