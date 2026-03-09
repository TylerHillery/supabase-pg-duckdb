CREATE EXTENSION pg_duckdb SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.orders (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    product_name TEXT        NOT NULL,
    quantity     INT         NOT NULL DEFAULT 1,
    unit_price   INTEGER     NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Full replica identity so CDC tools receive complete before/after row images
ALTER TABLE public.orders REPLICA IDENTITY FULL;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'orders_cdc') THEN
    CREATE PUBLICATION orders_cdc
        FOR TABLE public.orders
        WITH (publish = 'insert, update, delete');
    END IF;
END $$;

-- RLS 
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 
            1 
        FROM 
            pg_policies
        WHERE 
            schemaname = 'public' 
            AND tablename = 'orders'
            AND policyname = 'Users can view own orders'
    ) THEN
    CREATE POLICY "Users can view own orders"
        ON public.orders FOR SELECT
        USING (user_id = (select auth.uid()));
    END IF;
END $$;