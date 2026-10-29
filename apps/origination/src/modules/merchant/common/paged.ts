/** `Paged(item)` zod схемийн төрөл (contracts-ийн `Paged` нь утга тул generic төрөл тусад нь). */
export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }
