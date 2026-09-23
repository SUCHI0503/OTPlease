-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "requestedChannel" TEXT NOT NULL,
    "channel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "providerMessageId" TEXT,
    "toMasked" TEXT NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Delivery_applicationId_idx" ON "Delivery"("applicationId");

-- CreateIndex
CREATE INDEX "Delivery_providerMessageId_idx" ON "Delivery"("providerMessageId");
