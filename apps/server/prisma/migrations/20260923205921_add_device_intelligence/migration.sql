-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "lastIpMasked" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeenIp" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "ipMasked" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeenIp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Device_applicationId_idx" ON "Device"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_userId_deviceHash_key" ON "Device"("userId", "deviceHash");

-- CreateIndex
CREATE INDEX "SeenIp_applicationId_idx" ON "SeenIp"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "SeenIp_userId_ipHash_key" ON "SeenIp"("userId", "ipHash");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeenIp" ADD CONSTRAINT "SeenIp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
