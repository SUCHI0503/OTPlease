-- CreateTable
CREATE TABLE "RiskConfig" (
    "applicationId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskConfig_pkey" PRIMARY KEY ("applicationId")
);

-- CreateTable
CREATE TABLE "RiskDecision" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT,
    "decision" TEXT NOT NULL,
    "enforced" BOOLEAN NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" TEXT[],
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskDecision_applicationId_createdAt_idx" ON "RiskDecision"("applicationId", "createdAt");
