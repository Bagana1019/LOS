// Nest-ийн decorator metadata-д шаардлагатай. esbuild `emitDecoratorMetadata` дэмждэггүй тул
// constructor-ын хамаарал бүрийг `@Inject(...)`-ээр тодорхой зааж өгнө.
import 'reflect-metadata';
