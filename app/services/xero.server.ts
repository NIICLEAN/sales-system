import { XeroClient } from "xero-node";
import prisma from "../db.server";

const scopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.contacts",
  "accounting.transactions",
  "accounting.settings",
];

export function getXeroClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID || "",
    clientSecret: process.env.XERO_CLIENT_SECRET || "",
    redirectUris: [process.env.XERO_REDIRECT_URI || ""],
    scopes,
  });
}

export async function getXeroConnection() {
  return prisma.xeroConnection.findFirst({
    orderBy: {
      updatedAt: "desc",
    },
  });
}

export async function saveXeroConnection(tenantId: string, tokenSet: any) {
  const existing = await getXeroConnection();

  if (existing) {
    return prisma.xeroConnection.update({
      where: {
        id: existing.id,
      },
      data: {
        tenantId,
        tokenSet,
      },
    });
  }

  return prisma.xeroConnection.create({
    data: {
      tenantId,
      tokenSet,
    },
  });
}

export async function getConnectedXeroClient() {
  const connection = await getXeroConnection();

  if (!connection) {
    throw new Error("Xero is not connected yet.");
  }

  const xero = getXeroClient();

  xero.setTokenSet(connection.tokenSet as any);

  if (xero.readTokenSet().expired()) {
    const refreshedTokenSet = await xero.refreshToken();

    await saveXeroConnection(connection.tenantId, refreshedTokenSet);

    xero.setTokenSet(refreshedTokenSet);
  }

  return {
    xero,
    tenantId: connection.tenantId,
  };
}