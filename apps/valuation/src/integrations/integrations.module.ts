import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveIntegrationMode, type IntegrationMode } from './integration-mode';
import { createMockListingSources } from './listings/mock-vehicle-listing-source';
import { RealUneguiVehicleListingSource } from './listings/real-unegui-vehicle-listing-source';
import { VEHICLE_LISTING_SOURCES, type VehicleListingSource } from './listings/vehicle-listing-source.port';
import { MockVehicleRegistry } from './vehicle-registry/mock-vehicle-registry';
import { RealAtutVehicleRegistry } from './vehicle-registry/real-atut-vehicle-registry';
import { VEHICLE_REGISTRY, type VehicleRegistry } from './vehicle-registry/vehicle-registry.port';

// Resolved in the factories, i.e. while the application bootstraps, so a bad INTEGRATION_MODE stops the service at start-up.
const modeOf = (config: ConfigService): IntegrationMode =>
  resolveIntegrationMode({ INTEGRATION_MODE: config.get<string>('INTEGRATION_MODE'), NODE_ENV: config.get<string>('NODE_ENV') });

const logger = new Logger('Integrations');

/** Needs ConfigService in scope (AppModule registers ConfigModule globally). */
@Module({
  providers: [
    {
      provide: VEHICLE_REGISTRY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): VehicleRegistry => {
        if (modeOf(config) === 'real') return new RealAtutVehicleRegistry();
        logger.warn('INTEGRATION_MODE=mock: the vehicle registry and the classified ads are SIMULATED; valuations are not based on real data');
        return new MockVehicleRegistry();
      },
    },
    {
      provide: VEHICLE_LISTING_SOURCES,
      inject: [ConfigService],
      useFactory: (config: ConfigService): VehicleListingSource[] =>
        modeOf(config) === 'real' ? [new RealUneguiVehicleListingSource()] : createMockListingSources(),
    },
  ],
  exports: [VEHICLE_REGISTRY, VEHICLE_LISTING_SOURCES],
})
export class IntegrationsModule {}
