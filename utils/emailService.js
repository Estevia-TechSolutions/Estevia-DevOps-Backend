const nodemailer = require('nodemailer');

console.log('--- DevOps Email Service Initialization ---');
console.log('EMAIL_USER:', process.env.EMAIL_USER ? 'CONFIGURED' : 'MISSING');

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.office365.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: false, // STARTTLS
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false
    }
});

const sendMail = async ({ to, subject, html }) => {
    try {
        const from = process.env.EMAIL_FROM || `"EvaOps Alerts" <${process.env.EMAIL_USER}>`;
        const info = await transporter.sendMail({
            from,
            to,
            subject,
            html
        });
        console.log(`[EmailService] Email sent successfully to ${to}: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (err) {
        console.error('[EmailService] Failed to send email:', err.message);
        return { success: false, error: err.message };
    }
};

module.exports = {
    sendMail
};
