export const loader = async () => {
  const shopHandle = "niicleanproducts";
  const clientId = process.env.SHOPIFY_API_KEY || "";

  const installUrl = `https://admin.shopify.com/store/${shopHandle}/oauth/install?client_id=${clientId}`;

  return new Response(
    `
    <html>
      <body>
        <p>Redirecting to Shopify...</p>
        <script>
          window.top.location.href = ${JSON.stringify(installUrl)};
        </script>
        <a href="${installUrl}" target="_top">Click here if it does not continue</a>
      </body>
    </html>
    `,
    {
      headers: {
        "Content-Type": "text/html",
      },
    }
  );
};

export const action = loader;

export default function AuthLogin() {
  return null;
}