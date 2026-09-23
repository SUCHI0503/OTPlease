export interface Overview {
  range: { days: number };
  totals: { applications: number; otpRequests: number; logins: number };
  applications: { id: string; name: string; createdAt: string; otpRequests: number; logins: number }[];
}

export interface Analytics {
  range: { days: number; from: string; to: string };
  totals: {
    otpRequests: number;
    deliveriesSent: number;
    deliveriesDelivered: number;
    deliveriesFailed: number;
    deliverySuccessRate: number | null;
    logins: number;
    activeSessions: number;
    users: number;
    activeApiKeys: number;
    activeWebhooks: number;
    newDevices: number;
    webhookFailures: number;
  };
  byChannel: { channel: string; requests: number; failed: number }[];
  daily: { date: string; otpRequests: number; logins: number }[];
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
  revokedAt: string | null;
}

export const SCOPES = ["otp:request", "otp:verify", "users:read", "users:write", "deliveries:read", "analytics:read", "keys:manage", "webhooks:manage"];
export const WEBHOOK_EVENTS = ["otp.verified", "device.new", "delivery.sent", "delivery.delivered", "delivery.failed"];
