import 'reflect-metadata';
import { Logger } from '@nestjs/common';

// Тестийн stdout-г дуугүй болгоно; лог шалгах тест CapturingLogger-ээр дахин override хийнэ.
Logger.overrideLogger(false);
