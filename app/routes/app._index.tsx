import { useEffect, useMemo } from "react";
import {
  json,
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  createOptimizedContent,
  type OptimizedContent,
  type ProductSnapshot,
} from "../services/product-optimizer.server";

type FieldStatus = "ok" | "weak" | "missing";

type FieldHealth = {
  status: FieldStatus;
  message: string;
};

type AuditProduct = {
  id: string;
  title: string;
  descriptionHtml: string;
  tags: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  descriptionHealth: FieldHealth;
  tagsHealth: FieldHealth;
  seoTitleHealth: FieldHealth;
  seoDescriptionHealth: FieldHealth;
  lastOptimizedAt?: string;
  hasHistory: boolean;
};

type LoaderData = {
  products: AuditProduct[];
  summary: {
    total: number;
    needsAttention: number;
    recentlyOptimized: number;
  };
};

type ActionResponse = {
  intent: string;
  success?: boolean;
  error?: string;
  message?: string;
  productId?: string;
  optimized?: number;
  failed?: number;
};

type ShopifyProductNode = {
  id: string;
  title: string;
  descriptionHtml: string | null;
  tags: string[];
  seo?: {
    title: string | null;
    description: string | null;
  } | null;
};

type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

const STYLES = `
.audit-summary {
  display: grid;
  gap: var(--p-space-300);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.summary-tile {
  border-radius: var(--p-border-radius-300);
  padding: var(--p-space-300);
  display: flex;
  flex-direction: column;
  gap: var(--p-space-100);
  border: 1px solid var(--p-color-border-subdued);
  background: var(--p-color-bg-surface);
}

.summary-tile--success {
  border-color: var(--p-color-border-success-subdued);
  background: var(--p-color-bg-surface-success);
}

.summary-tile--critical {
  border-color: var(--p-color-border-critical-subdued);
  background: var(--p-color-bg-surface-critical);
}

.summary-value {
  font-size: 28px;
  font-weight: 600;
  line-height: 1;
}

.summary-label {
  color: var(--p-color-text-subdued);
  font-size: 13px;
}

.audit-table {
  display: flex;
  flex-direction: column;
  gap: var(--p-space-200);
}

.audit-header,
.audit-row {
  display: grid;
  grid-template-columns: 2.2fr 1fr 1fr 1fr 1fr 1.2fr;
  gap: var(--p-space-200);
  align-items: start;
}

.audit-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--p-color-text-subdued);
}

.audit-row {
  padding: var(--p-space-200) 0;
  border-top: 1px solid var(--p-color-border-subdued);
}

.audit-row:first-of-type {
  border-top: none;
}

.audit-empty {
  padding: var(--p-space-400) 0;
  text-align: center;
}

@media (max-width: 1100px) {
  .audit-header,
  .audit-row {
    grid-template-columns: 1.6fr 1fr 1fr;
    grid-auto-rows: auto;
    grid-row-gap: var(--p-space-200);
  }

  .audit-header span:nth-child(n + 3),
  .audit-row > :nth-child(n + 3) {
    display: none;
  }

  .audit-row > :last-child {
    grid-column: 2 / span 2;
  }
}
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const response = await admin.graphql(
    `#graphql
      query productAudit($first: Int!) {
        products(first: $first, sortKey: UPDATED_AT) {
          edges {
            node {
              id
              title
              descriptionHtml
              tags
              seo {
                title
                description
              }
              status
              onlineStoreUrl
            }
          }
        }
      }
    `,
    { variables: { first: 25 } },
  );

  const payload = await response.json();

  if (payload?.errors?.length) {
    console.error(payload.errors);
    throw new Error("Unable to load products from Shopify");
  }

  const edges = (payload?.data?.products?.edges ?? []) as Array<{ node: ShopifyProductNode }>;
  const products: AuditProduct[] = edges.map(({ node }) => mapProductToAudit(node));

  const productIds = products.map((product) => product.id);

  const histories = productIds.length
    ? await prisma.productOptimization.findMany({
        where: { shop, productId: { in: productIds } },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const historyMap = new Map<string, (typeof histories)[number]>();
  for (const record of histories) {
    if (!historyMap.has(record.productId)) {
      historyMap.set(record.productId, record);
    }
  }

  const enrichedProducts = products.map((product) => ({
    ...product,
    lastOptimizedAt: historyMap.get(product.id)?.createdAt.toISOString(),
    hasHistory: historyMap.has(product.id),
  }));

  const needsAttention = enrichedProducts.filter((product) =>
    [
      product.descriptionHealth.status,
      product.tagsHealth.status,
      product.seoTitleHealth.status,
      product.seoDescriptionHealth.status,
    ].some((status) => status !== "ok"),
  );

  const loaderData: LoaderData = {
    products: enrichedProducts,
    summary: {
      total: enrichedProducts.length,
      needsAttention: needsAttention.length,
      recentlyOptimized: historyMap.size,
    },
  };

  return json(loaderData);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "optimize") {
      const productId = String(formData.get("productId") ?? "");
      if (!productId) {
        throw new Error("A product id is required");
      }

      await optimizeProduct(admin, shop, productId);

      return json<ActionResponse>({
        intent,
        success: true,
        productId,
        message: "Product optimized",
      });
    }

    if (intent === "bulk") {
      const productIdsRaw = formData.get("productIds");
      if (typeof productIdsRaw !== "string") {
        throw new Error("No products were selected for bulk optimization");
      }

      let productIds: string[] = [];
      try {
        productIds = JSON.parse(productIdsRaw) as string[];
      } catch (error) {
        console.error("Invalid productIds payload", error);
        throw new Error("No products were selected for bulk optimization");
      }
      if (!Array.isArray(productIds) || productIds.length === 0) {
        throw new Error("No products were selected for bulk optimization");
      }

      let optimized = 0;
      let failed = 0;

      for (const productId of productIds) {
        try {
          await optimizeProduct(admin, shop, productId);
          optimized += 1;
        } catch (error) {
          console.error(`Failed to optimize product ${productId}`, error);
          failed += 1;
        }
      }

      return json<ActionResponse>({
        intent,
        success: failed === 0,
        optimized,
        failed,
        message: `Optimized ${optimized} product${optimized === 1 ? "" : "s"}`,
        ...(failed
          ? { error: `${failed} product${failed === 1 ? "" : "s"} failed to optimize` }
          : {}),
      });
    }

    if (intent === "rollback") {
      const productId = String(formData.get("productId") ?? "");
      if (!productId) {
        throw new Error("A product id is required to rollback");
      }

      const record = await prisma.productOptimization.findFirst({
        where: { shop, productId },
        orderBy: { createdAt: "desc" },
      });

      if (!record) {
        throw new Error("No saved version is available for this product");
      }

      let previousTags: string[] = [];
      if (record.previousTags) {
        try {
          previousTags = JSON.parse(record.previousTags) as string[];
        } catch (error) {
          console.warn("Failed to parse stored tags for rollback", error);
        }
      }

      const previous: OptimizedContent = {
        descriptionHtml: record.previousDescriptionHtml ?? "",
        tags: previousTags,
        seoTitle: record.previousSeoTitle ?? "",
        seoDescription: record.previousSeoDescription ?? "",
      };

      await applyProductUpdate(admin, productId, previous);

      return json<ActionResponse>({
        intent,
        success: true,
        productId,
        message: "Product content restored",
      });
    }

    throw new Error("Unsupported action");
  } catch (error) {
    console.error(error);
    const message =
      error instanceof Error ? error.message : "Something went wrong while processing the request";

    return json<ActionResponse>({ intent, success: false, error: message }, { status: 500 });
  }
};

export default function Index() {
  const data = useLoaderData<LoaderData>();
  const optimizeFetcher = useFetcher<ActionResponse>();
  const bulkFetcher = useFetcher<ActionResponse>();
  const rollbackFetcher = useFetcher<ActionResponse>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const needsOptimization = useMemo(
    () =>
      data.products.filter((product) =>
        [
          product.descriptionHealth.status,
          product.tagsHealth.status,
          product.seoTitleHealth.status,
          product.seoDescriptionHealth.status,
        ].some((status) => status !== "ok"),
      ),
    [data.products],
  );

  useEffect(() => {
    const fetchers = [optimizeFetcher, bulkFetcher, rollbackFetcher];
    const completed = fetchers.find(
      (fetcher) => fetcher.state === "idle" && fetcher.data?.message && fetcher.data.success !== false,
    );

    if (completed?.data?.message) {
      shopify.toast.show(completed.data.message);
      revalidator.revalidate();
    }

    const errorFetcher = fetchers.find(
      (fetcher) => fetcher.state === "idle" && fetcher.data?.success === false && fetcher.data.error,
    );

    if (errorFetcher?.data?.error) {
      shopify.toast.show(errorFetcher.data.error, { isError: true });
    }
  }, [optimizeFetcher, bulkFetcher, rollbackFetcher, revalidator, shopify]);

  const isBulkOptimizing = bulkFetcher.state !== "idle";
  const optimizeTargetId = optimizeFetcher.formData?.get("productId");
  const rollbackTargetId = rollbackFetcher.formData?.get("productId");

  return (
    <s-page heading="AI Product Optimizer">
      <s-layout>
        <s-layout-section>
          <style dangerouslySetInnerHTML={{ __html: STYLES }} />
          <s-card>
            <s-block-stack gap="base">
              <s-text variant="bodyMd">
                Audit every product description, tag, and SEO field, then refresh them with AI-crafted content optimised for
                conversions and search.
              </s-text>
              <s-inline-stack gap="base">
                <s-button
                  onClick={() =>
                    needsOptimization.length === 0
                      ? undefined
                      : bulkFetcher.submit(
                          {
                            intent: "bulk",
                            productIds: JSON.stringify(needsOptimization.map((product) => product.id)),
                          },
                          { method: "POST" },
                        )
                  }
                  disabled={needsOptimization.length === 0 || isBulkOptimizing}
                  {...(isBulkOptimizing ? { loading: true } : {})}
                >
                  Bulk optimize {needsOptimization.length ? `(${needsOptimization.length})` : ""}
                </s-button>
                <s-button
                  variant="tertiary"
                  onClick={() => revalidator.revalidate()}
                  disabled={revalidator.state !== "idle"}
                >
                  Refresh audit
                </s-button>
              </s-inline-stack>
            </s-block-stack>
          </s-card>

          <s-block-stack gap="base" style={{ marginTop: "var(--p-space-400)" }}>
            <s-text variant="headingLg">Product health overview</s-text>
            <div className="audit-summary">
              <SummaryTile label="Products" value={data.summary.total.toString()} />
              <SummaryTile label="Needs attention" value={data.summary.needsAttention.toString()} tone="critical" />
              <SummaryTile label="Optimized" value={data.summary.recentlyOptimized.toString()} tone="success" />
            </div>
          </s-block-stack>

          <s-card title="Audit details" sectioned>
            <div className="audit-table">
              <div className="audit-header">
                <span>Product</span>
                <span>Description</span>
                <span>Tags</span>
                <span>SEO Title</span>
                <span>SEO Description</span>
                <span>Actions</span>
              </div>
              {data.products.map((product) => {
                const needsWork =
                  product.descriptionHealth.status !== "ok" ||
                  product.tagsHealth.status !== "ok" ||
                  product.seoTitleHealth.status !== "ok" ||
                  product.seoDescriptionHealth.status !== "ok";

                return (
                  <div key={product.id} className="audit-row">
                    <div>
                      <s-text variant="bodyMd" fontWeight="medium">
                        {product.title}
                      </s-text>
                      {product.lastOptimizedAt ? (
                        <s-text variant="bodySm" tone="subdued">
                          Updated {new Date(product.lastOptimizedAt).toLocaleString()}
                        </s-text>
                      ) : null}
                    </div>
                    <FieldBadge health={product.descriptionHealth} />
                    <FieldBadge health={product.tagsHealth} />
                    <FieldBadge health={product.seoTitleHealth} />
                    <FieldBadge health={product.seoDescriptionHealth} />
                    <s-inline-stack gap="base" align="end">
                      <s-button
                        variant="primary"
                        onClick={() =>
                          optimizeFetcher.submit({ intent: "optimize", productId: product.id }, { method: "POST" })
                        }
                        disabled={!needsWork || optimizeFetcher.state !== "idle"}
                        {...(optimizeTargetId === product.id ? { loading: true } : {})}
                      >
                        Fix
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          rollbackFetcher.submit({ intent: "rollback", productId: product.id }, { method: "POST" })
                        }
                        disabled={!product.hasHistory || rollbackFetcher.state !== "idle"}
                        {...(rollbackTargetId === product.id ? { loading: true } : {})}
                      >
                        Rollback
                      </s-button>
                    </s-inline-stack>
                  </div>
                );
              })}
              {data.products.length === 0 ? (
                <div className="audit-empty">
                  <s-text variant="bodyMd">No products were found. Create a product to get started.</s-text>
                </div>
              ) : null}
            </div>
          </s-card>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}

function FieldBadge({ health }: { health: FieldHealth }) {
  const tone =
    health.status === "ok" ? "success" : health.status === "weak" ? "attention" : "critical";

  return (
    <s-block-stack gap="extra-tight">
      <s-badge tone={tone}>{labelForStatus(health.status)}</s-badge>
      <s-text variant="bodySm" tone="subdued">
        {health.message}
      </s-text>
    </s-block-stack>
  );
}

function SummaryTile({
  label,
  value,
  tone = "info",
}: {
  label: string;
  value: string;
  tone?: "info" | "success" | "critical";
}) {
  return (
    <div className={`summary-tile summary-tile--${tone}`}>
      <span className="summary-value">{value}</span>
      <span className="summary-label">{label}</span>
    </div>
  );
}

function labelForStatus(status: FieldStatus) {
  switch (status) {
    case "ok":
      return "Healthy";
    case "weak":
      return "Needs work";
    case "missing":
      return "Missing";
    default:
      return status;
  }
}

function mapProductToAudit(node: ShopifyProductNode): AuditProduct {
  const descriptionHealth = evaluateDescription(node.descriptionHtml ?? "");
  const tagsHealth = evaluateTags(node.tags ?? []);
  const seoTitleHealth = evaluateSeoTitle(node.seo?.title ?? "");
  const seoDescriptionHealth = evaluateSeoDescription(node.seo?.description ?? "");

  return {
    id: node.id,
    title: node.title,
    descriptionHtml: node.descriptionHtml ?? "",
    tags: node.tags ?? [],
    seoTitle: node.seo?.title ?? null,
    seoDescription: node.seo?.description ?? null,
    descriptionHealth,
    tagsHealth,
    seoTitleHealth,
    seoDescriptionHealth,
    hasHistory: false,
  };
}

function evaluateDescription(descriptionHtml: string): FieldHealth {
  const text = descriptionHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) {
    return { status: "missing", message: "No description" };
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 60) {
    return { status: "weak", message: `${wordCount} word${wordCount === 1 ? "" : "s"}` };
  }

  return { status: "ok", message: `${wordCount} words` };
}

function evaluateTags(tags: string[]): FieldHealth {
  if (!tags || tags.length === 0) {
    return { status: "missing", message: "No tags" };
  }

  if (tags.length < 3) {
    return { status: "weak", message: `${tags.length} tag${tags.length === 1 ? "" : "s"}` };
  }

  return { status: "ok", message: `${tags.length} tags` };
}

function evaluateSeoTitle(seoTitle: string): FieldHealth {
  if (!seoTitle) {
    return { status: "missing", message: "No SEO title" };
  }

  if (seoTitle.length < 35 || seoTitle.length > 60) {
    return { status: "weak", message: `${seoTitle.length} characters` };
  }

  return { status: "ok", message: `${seoTitle.length} characters` };
}

function evaluateSeoDescription(seoDescription: string): FieldHealth {
  if (!seoDescription) {
    return { status: "missing", message: "No meta description" };
  }

  if (seoDescription.length < 110 || seoDescription.length > 160) {
    return { status: "weak", message: `${seoDescription.length} characters` };
  }

  return { status: "ok", message: `${seoDescription.length} characters` };
}

async function optimizeProduct(
  admin: AdminClient,
  shop: string,
  productId: string,
) {
  const snapshot = await fetchProductSnapshot(admin, productId);
  const optimized = await createOptimizedContent(snapshot);

  await applyProductUpdate(admin, productId, optimized);

  await prisma.productOptimization.create({
    data: {
      shop,
      productId,
      previousDescriptionHtml: snapshot.descriptionHtml ?? "",
      previousTags: JSON.stringify(snapshot.tags ?? []),
      previousSeoTitle: snapshot.seoTitle ?? "",
      previousSeoDescription: snapshot.seoDescription ?? "",
      optimizedDescriptionHtml: optimized.descriptionHtml,
      optimizedTags: JSON.stringify(optimized.tags),
      optimizedSeoTitle: optimized.seoTitle,
      optimizedSeoDescription: optimized.seoDescription,
    },
  });
}

async function fetchProductSnapshot(
  admin: AdminClient,
  productId: string,
): Promise<ProductSnapshot> {
  const response = await admin.graphql(
    `#graphql
      query productSnapshot($id: ID!) {
        product(id: $id) {
          id
          title
          descriptionHtml
          tags
          seo {
            title
            description
          }
        }
      }
    `,
    { variables: { id: productId } },
  );

  const payload = await response.json();

  if (payload?.errors?.length) {
    throw new Error(payload.errors[0]?.message ?? "Unable to load product");
  }

  const product = payload?.data?.product;

  if (!product) {
    throw new Error("Product not found");
  }

  return {
    id: product.id,
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    tags: product.tags ?? [],
    seoTitle: product.seo?.title,
    seoDescription: product.seo?.description,
  };
}

async function applyProductUpdate(
  admin: AdminClient,
  productId: string,
  optimized: OptimizedContent,
) {
  const response = await admin.graphql(
    `#graphql
      mutation optimizeProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          userErrors {
            message
          }
        }
      }
    `,
    {
      variables: {
        input: {
          id: productId,
          descriptionHtml: optimized.descriptionHtml,
          tags: optimized.tags,
          seo: {
            title: optimized.seoTitle,
            description: optimized.seoDescription,
          },
        },
      },
    },
  );

  const payload = await response.json();
  const userErrors = payload?.data?.productUpdate?.userErrors ?? [];

  if (userErrors.length) {
    throw new Error(userErrors.map((error: { message: string }) => error.message).join(", "));
  }
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

