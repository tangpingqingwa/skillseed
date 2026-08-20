export const GENERATE_PRICE_CENTS = 2900;
export const GENERATE_CURRENCY = "usd";
export const GENERATE_SKU = "generate";

export type CheckoutSessionStatus = "open" | "complete" | "expired";

export type CreateCheckoutInput = {
  jobId: string;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutSession = {
  id: string;
  url: string;
  status: CheckoutSessionStatus;
  jobId: string;
  amountCents: number;
  currency: string;
};

export type StripePort = {
  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSession | undefined>;
  completeCheckoutSession(id: string): Promise<CheckoutSession>;
};

export class StripeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeError";
  }
}

function assertSecretKey(secretKey: string): void {
  if (!secretKey) throw new StripeError("LiveStripePort requires secretKey");
}

/** In-memory Checkout. Default in tests and CI. Never talks to Stripe. */
export class FakeStripePort implements StripePort {
  private readonly sessions = new Map<string, CheckoutSession>();
  private seq = 0;

  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    this.seq += 1;
    const id = `cs_test_${this.seq}`;
    const session: CheckoutSession = {
      id,
      url: `/checkout/fake/${id}`,
      status: "open",
      jobId: input.jobId,
      amountCents: GENERATE_PRICE_CENTS,
      currency: GENERATE_CURRENCY,
    };
    this.sessions.set(id, session);
    return { ...session };
  }

  async retrieveCheckoutSession(id: string): Promise<CheckoutSession | undefined> {
    const session = this.sessions.get(id);
    return session ? { ...session } : undefined;
  }

  async completeCheckoutSession(id: string): Promise<CheckoutSession> {
    const session = this.sessions.get(id);
    if (!session) throw new StripeError(`unknown checkout session: ${id}`);
    if (session.status === "expired") throw new StripeError(`checkout session expired: ${id}`);
    session.status = "complete";
    return { ...session };
  }
}

type StripeCheckoutClient = {
  checkout: {
    sessions: {
      create(params: {
        mode: "payment";
        line_items: Array<{
          quantity: number;
          price_data: {
            currency: string;
            unit_amount: number;
            product_data: { name: string };
          };
        }>;
        success_url: string;
        cancel_url: string;
        metadata: { jobId: string; sku: string };
      }): Promise<{ id: string; url: string | null; status: string | null; metadata?: { jobId?: string } | null }>;
      retrieve(id: string): Promise<{
        id: string;
        url: string | null;
        status: string | null;
        payment_status?: string;
        metadata?: { jobId?: string } | null;
      }>;
    };
  };
};

function mapLiveStatus(status: string | null | undefined, paymentStatus?: string): CheckoutSessionStatus {
  if (status === "complete" || paymentStatus === "paid") return "complete";
  if (status === "expired") return "expired";
  return "open";
}

/** Env-gated live Stripe. Tests and CI never construct this. */
export class LiveStripePort implements StripePort {
  private constructor(private readonly stripe: StripeCheckoutClient) {}

  static async connect(secretKey: string): Promise<LiveStripePort> {
    assertSecretKey(secretKey);
    const { default: Stripe } = await import("stripe");
    return new LiveStripePort(new Stripe(secretKey) as unknown as StripeCheckoutClient);
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const created = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: GENERATE_CURRENCY,
            unit_amount: GENERATE_PRICE_CENTS,
            product_data: { name: "SkillSeed generate" },
          },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: { jobId: input.jobId, sku: GENERATE_SKU },
    });
    if (!created.url) throw new StripeError("Stripe Checkout returned no URL");
    return {
      id: created.id,
      url: created.url,
      status: mapLiveStatus(created.status),
      jobId: created.metadata?.jobId || input.jobId,
      amountCents: GENERATE_PRICE_CENTS,
      currency: GENERATE_CURRENCY,
    };
  }

  async retrieveCheckoutSession(id: string): Promise<CheckoutSession | undefined> {
    const session = await this.stripe.checkout.sessions.retrieve(id);
    return {
      id: session.id,
      url: session.url ?? "",
      status: mapLiveStatus(session.status, session.payment_status),
      jobId: session.metadata?.jobId || "",
      amountCents: GENERATE_PRICE_CENTS,
      currency: GENERATE_CURRENCY,
    };
  }

  async completeCheckoutSession(): Promise<CheckoutSession> {
    throw new StripeError("live Stripe checkout is completed on Stripe-hosted pages, not locally");
  }
}

export function isLiveStripeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SKILLSEED_USE_LIVE_STRIPE === "1" && Boolean(env.STRIPE_SECRET_KEY);
}

export function createStripePort(env: NodeJS.ProcessEnv = process.env): StripePort {
  if (isLiveStripeEnabled(env)) {
    throw new StripeError("live Stripe must be constructed via LiveStripePort.connect");
  }
  return new FakeStripePort();
}
