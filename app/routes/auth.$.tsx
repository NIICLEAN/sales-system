import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return await authenticate.admin(request);
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};