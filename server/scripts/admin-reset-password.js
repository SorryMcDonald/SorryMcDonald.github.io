import { hashPassword } from '../src/auth/password.js';

const email = process.argv[2]; const password = process.env.NEW_PASSWORD;
if (!email || !password) { console.error('usage: NEW_PASSWORD=... node scripts/admin-reset-password.js email'); process.exitCode = 1; } else {
  console.log(JSON.stringify({ email: email.trim().toLowerCase(), passwordHash: await hashPassword(password), next: '用受保护的管理员 SQL 事务更新 users.password_hash；不要把密码写入日志' }));
}
