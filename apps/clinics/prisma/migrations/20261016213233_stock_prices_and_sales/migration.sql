-- AlterTable
ALTER TABLE "stock_items" ADD COLUMN     "purchase_price" INTEGER,
ADD COLUMN     "sale_price" INTEGER;

-- CreateTable
CREATE TABLE "stock_sales" (
    "id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "stock_item_id" UUID,
    "item_name" VARCHAR(64) NOT NULL,
    "category" "StockCategory" NOT NULL,
    "unit" "StockUnit" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_sale_price" INTEGER NOT NULL,
    "unit_purchase_price" INTEGER NOT NULL,
    "sold_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,

    CONSTRAINT "stock_sales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_sales_clinic_id_sold_at_idx" ON "stock_sales"("clinic_id", "sold_at");

-- CreateIndex
CREATE INDEX "stock_sales_stock_item_id_idx" ON "stock_sales"("stock_item_id");

-- AddForeignKey
ALTER TABLE "stock_sales" ADD CONSTRAINT "stock_sales_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_sales" ADD CONSTRAINT "stock_sales_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_prices_check" CHECK (("purchase_price" IS NULL OR "purchase_price" BETWEEN 0 AND 1000000000) AND ("sale_price" IS NULL OR "sale_price" BETWEEN 0 AND 1000000000));

ALTER TABLE "stock_sales" ADD CONSTRAINT "stock_sales_quantity_check" CHECK ("quantity" BETWEEN 1 AND 100000);

ALTER TABLE "stock_sales" ADD CONSTRAINT "stock_sales_prices_check" CHECK ("unit_sale_price" BETWEEN 0 AND 1000000000 AND "unit_purchase_price" BETWEEN 0 AND 1000000000);
