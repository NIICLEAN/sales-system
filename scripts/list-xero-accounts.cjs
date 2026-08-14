'use strict';
const { PrismaClient } = require('../node_modules/@prisma/client');
const { XeroClient } = require('../node_modules/xero-node');

const xeroInfo = JSON.parse(process.env.XERO_INFO || '{}');
const prisma = new PrismaClient();

(async () => {
  const conn = await prisma.xeroConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
  const xero = new XeroClient({ clientId: xeroInfo.id, clientSecret: xeroInfo.secret, redirectUris: [], scopes: [] });
  xero.setTokenSet(conn.tokenSet);
  await xero.initialize();
  if (xero.readTokenSet().expired()) {
    xero.setTokenSet(await xero.refreshToken());
  }
  const res = await xero.accountingApi.getAccounts(conn.tenantId);
  console.log('status:', res.response?.statusCode);
  const all = res.body?.accounts || [];
  console.log('Total accounts:', all.length);
  all.forEach(a => console.log(a.type, '|', a.accountID, '|', a.code, '|', a.name));
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); prisma.$disconnect(); });
