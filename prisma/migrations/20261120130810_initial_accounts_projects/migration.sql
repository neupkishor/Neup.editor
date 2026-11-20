-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('individual', 'brand', 'dependent');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "displayName" TEXT,
    "displayImage" TEXT,
    "neupid" TEXT,
    "type" "AccountType" NOT NULL DEFAULT 'individual',
    "details" JSONB,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "accountId" UUID,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "mediaLocations" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_neupid_key" ON "accounts"("neupid");

-- CreateIndex
CREATE INDEX "projects_accountId_idx" ON "projects"("accountId");

-- CreateIndex
CREATE INDEX "projects_updatedAt_idx" ON "projects"("updatedAt");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
