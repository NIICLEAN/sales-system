export async function getPrimaryLocationId(admin: any) {
  const response = await admin.graphql(`
    {
      locations(first: 10) {
        edges {
          node {
            id
            name
            address {
              city
            }
          }
        }
      }
    }
  `);

  const json = await response.json();

  const edges = json.data?.locations?.edges || [];

  if (edges.length === 0) return null;

  return edges[0].node.id;
}

export async function getInventoryItemIdForVariant(admin: any, variantId: string) {
  const response = await admin.graphql(
    `query VariantInventory($id: ID!) {\n      productVariant(id: $id) {\n        id\n        inventoryItem { id }\n      }\n    }`,
    { variables: { id: variantId } },
  );

  const json = await response.json();

  return json.data?.productVariant?.inventoryItem?.id || null;
}

export async function adjustInventoryForLineItems(admin: any, lineItems: Array<{ id: string; quantity: number }>) {
  // Find a location to adjust inventory at
  const locationId = await getPrimaryLocationId(admin);

  if (!locationId) {
    console.warn("No shop locations found - cannot adjust inventory");
    return;
  }

  for (const item of lineItems) {
    if (!item.id) continue;

    try {
      const inventoryItemId = await getInventoryItemIdForVariant(admin, item.id);

      if (!inventoryItemId) {
        console.warn(`No inventory item found for variant ${item.id}`);
        continue;
      }

      const mutation = `mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {\n        inventoryAdjustQuantities(input: $input) {\n          userErrors { field message }\n        }\n      }`;

      const variables = {
        input: {
          reason: "correction",
          name: "available",
          changes: [{
            inventoryItemId,
            locationId,
            delta: -Math.abs(Number(item.quantity) || 0),
          }],
        },
      };

      const resp = await admin.graphql(mutation, { variables });

      const respJson = await resp.json();

      const errors = respJson.data?.inventoryAdjustQuantities?.userErrors || [];

      if (errors.length > 0) {
        console.error("Inventory adjust errors:", errors);
      }
    } catch (err) {
      console.error("Failed to adjust inventory for", item.id, err);
    }
  }
}

export default {
  getPrimaryLocationId,
  getInventoryItemIdForVariant,
  adjustInventoryForLineItems,
};
