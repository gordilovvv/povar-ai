import { hashPassword } from '#Dashboard/Lib/Password.js';

const password = process.argv[2];
if (!password) {
    console.error('usage: tsx --conditions=development scripts/HashPassword.ts <password>');
    process.exit(1);
}

console.log(hashPassword(password));
