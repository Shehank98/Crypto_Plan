import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../lib/env.js";

export interface JwtPayload {
  userId: number;
  email: string;
}

const SALT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: JwtPayload): string {
  const options: jwt.SignOptions = {
    expiresIn: env.jwtExpiresIn() as jwt.SignOptions["expiresIn"],
  };
  return jwt.sign(payload, env.jwtSecret(), options);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.jwtSecret()) as JwtPayload;
}
