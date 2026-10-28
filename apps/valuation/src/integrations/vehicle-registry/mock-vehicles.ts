import type { VehicleInfo } from '@los/contracts';

// Fixtures of MockVehicleRegistry. EVERY owner name, register number and VIN below is FICTIONAL and made up for demos and tests;
// none refers to a real person, company or vehicle. Never copy real registry data in here (CLAUDE.md §6.5).
// Register numbers follow the Mongolian shape (2 Cyrillic letters + 8 digits for an individual, 7 digits for a company) but use the
// impossible all-zero date part / serial, so none of them can belong to a real person or company.

export const MOCK_VEHICLES: readonly VehicleInfo[] = [
  {
    plateNo: 'УЕН5246',
    vin: 'MOCKVIN0000000001',
    make: 'Toyota',
    model: 'Prius',
    manufactureYear: 2012,
    importYear: 2016,
    engineCc: 1798,
    fuelType: 'HYBRID',
    color: 'Цагаан',
    owner: { registerNo: 'УЕ00000001', name: 'Жишээ Бат-Эрдэнэ' },
    registeredAt: '2016-05-20',
  },
  {
    plateNo: '1234УБА',
    vin: 'MOCKVIN0000000002',
    make: 'Toyota',
    model: 'Land Cruiser Prado',
    manufactureYear: 2015,
    importYear: 2018,
    engineCc: 2755,
    fuelType: 'DIESEL',
    color: 'Хар',
    owner: { registerNo: '0000001', name: 'Хөгжил Трейд ХХК' },
    registeredAt: '2018-09-14',
  },
  {
    plateNo: '5678УНА',
    vin: 'MOCKVIN0000000003',
    make: 'Hyundai',
    model: 'Sonata',
    manufactureYear: 2017,
    importYear: 2019,
    engineCc: 1999,
    fuelType: 'LPG',
    color: 'Мөнгөлөг',
    owner: { registerNo: 'ЖИ00000002', name: 'Жишээ Сарангэрэл' },
    registeredAt: '2019-03-02',
  },
  {
    // The mock listing sources hold only two ads for this vehicle: exercises the "too few comparables" path.
    plateNo: '7001УБЭ',
    vin: 'MOCKVIN0000000004',
    make: 'Lexus',
    model: 'LX 570',
    manufactureYear: 2018,
    importYear: 2020,
    engineCc: 5663,
    fuelType: 'PETROL',
    color: 'Хар',
    owner: { registerNo: 'ТЭ00000003', name: 'Жишээ Ганбаатар' },
    registeredAt: '2020-07-08',
  },
  {
    // The mock listing sources hold no ads for this vehicle: exercises the "no data at all" path.
    plateNo: '3030БАА',
    vin: 'MOCKVIN0000000005',
    make: 'Daewoo',
    model: 'Damas',
    manufactureYear: 2005,
    importYear: null,
    engineCc: 796,
    fuelType: 'PETROL',
    color: null,
    owner: { registerNo: '0000002', name: 'Жишээ Худалдаа ХХК' },
    registeredAt: '2010-04-15',
  },
];
