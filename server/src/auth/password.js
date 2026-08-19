import argon2 from 'argon2';

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('密码至少需要 8 位');
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash, password) {
  if (!hash || typeof password !== 'string') return false;
  try { return await argon2.verify(hash, password); } catch { return false; }
}
