/** Display identity only. It is not a credential, command or authorization to repeat an operation. */
export interface NotificationReference { key: string; eventId?: string }
/** Correlation only. The receiver still validates and executes the original business request. */
export interface NotificationOperationRequest { notificationId: string }
