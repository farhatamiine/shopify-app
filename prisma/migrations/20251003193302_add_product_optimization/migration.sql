-- CreateTable
CREATE TABLE "ProductOptimization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "previousDescriptionHtml" TEXT,
    "previousTags" TEXT,
    "previousSeoTitle" TEXT,
    "previousSeoDescription" TEXT,
    "optimizedDescriptionHtml" TEXT,
    "optimizedTags" TEXT,
    "optimizedSeoTitle" TEXT,
    "optimizedSeoDescription" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
