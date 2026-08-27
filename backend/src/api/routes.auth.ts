import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { hashPassword, signToken, verifyPassword } from "./auth.js";
import { asyncHandler, HttpError } from "./middleware.js";
import { credentialsSchema } from "./validation.js";

export const authRouter = Router();

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password } = credentialsSchema.parse(req.body);
    const passwordHash = await hashPassword(password);
    try {
      const user = await prisma.user.create({
        data: { email: email.toLowerCase(), passwordHash },
        select: { id: true, email: true, createdAt: true },
      });
      const token = signToken({ userId: user.id, email: user.email });
      res.status(201).json({ user, token });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(409, "Email already registered");
      }
      throw err;
    }
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = credentialsSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, "Invalid credentials");
    }
    const token = signToken({ userId: user.id, email: user.email });
    res.json({ user: { id: user.id, email: user.email, createdAt: user.createdAt }, token });
  }),
);
