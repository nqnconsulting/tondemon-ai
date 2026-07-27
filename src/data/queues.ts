import type { DlqMessage, QueueStatus } from "../types.js";

// Anypoint MQ state. order-events-dlq is the smoking gun: 47 parked orders, all
// rejected at salesforce-sapi with the same 401.

export const QUEUES: QueueStatus[] = [
  {
    name: "order-events",
    depth: 0,
    inFlight: 1,
    deadLetterQueue: "order-events-dlq",
    oldestMessageAgeMin: 0,
    publishRpm: 42,
    consumeRpm: 41,
  },
  {
    name: "order-events-dlq",
    depth: 47,
    inFlight: 0,
    oldestMessageAgeMin: 72,
    publishRpm: 0.6,
    consumeRpm: 0,
  },
  {
    name: "inventory-adjustment-events",
    depth: 2,
    inFlight: 1,
    deadLetterQueue: "inventory-adjustment-events-dlq",
    oldestMessageAgeMin: 1,
    publishRpm: 22,
    consumeRpm: 22,
  },
  {
    name: "inventory-adjustment-events-dlq",
    depth: 0,
    inFlight: 0,
    oldestMessageAgeMin: 0,
    publishRpm: 0,
    consumeRpm: 0,
  },
];

function makeOrderDlqMessage(
  n: number,
  orderNo: string,
  enqueuedMinutesAgo: number,
  customer: string,
  amount: number,
): DlqMessage {
  return {
    messageId: `amq-msg-${n}`,
    queue: "order-events-dlq",
    correlationId: `ORD-${orderNo}`,
    businessKey: orderNo,
    enqueuedMinutesAgo,
    errorCode: "HTTP:UNAUTHORIZED",
    errorMessage:
      "salesforce-sapi returned 401 Unauthorized (SALESFORCE:OAUTH_401 — token endpoint rejected client). Retries exhausted (3/3).",
    failedAt: "salesforce-sapi",
    redeliveryCount: 3,
    payloadExcerpt: {
      eventType: "ORDER_CREATED",
      orderNumber: orderNo,
      customerId: customer,
      totalAmount: amount,
      currency: "EUR",
      target: "salesforce-crm",
    },
  };
}

// 47 in reality; we expose a representative, newest-first sample.
export const DLQ_MESSAGES: DlqMessage[] = [
  makeOrderDlqMessage(9001, "10042", 4, "CUST-3391", 219.9),
  makeOrderDlqMessage(9000, "10041", 9, "CUST-2210", 84.5),
  makeOrderDlqMessage(8999, "10040", 17, "CUST-8842", 1299.0),
  makeOrderDlqMessage(8998, "10039", 26, "CUST-3391", 49.99),
  makeOrderDlqMessage(8997, "10038", 38, "CUST-5120", 612.4),
  makeOrderDlqMessage(8996, "10037", 51, "CUST-7733", 33.0),
  makeOrderDlqMessage(8995, "10036", 64, "CUST-1098", 458.2),
  makeOrderDlqMessage(8994, "10035", 72, "CUST-2210", 129.0),
];

export function getQueue(name: string): QueueStatus | undefined {
  return QUEUES.find((q) => q.name === name);
}

export function getDlqMessages(queue: string): DlqMessage[] {
  return DLQ_MESSAGES.filter((m) => m.queue === queue);
}
