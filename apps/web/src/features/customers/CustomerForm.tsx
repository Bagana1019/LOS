'use client';
import { useEffect, useState } from 'react';
import { App as AntApp, AutoComplete, Button, Card, Checkbox, Divider, Flex, Form, Input, InputNumber, Select, Typography, Upload } from 'antd';
import { CustomerContactRelation, Gender, MaritalStatus, type CustomerType, type CustomerInputRaw } from '@los/contracts';
import { t } from '../../lib/i18n';
import { uploadDmsFile } from '../documents/shared/files';
import { buildPayload, validateCustomer } from './customers.utils';

type Values = Record<string, unknown>;
interface Props {
  customerType: CustomerType;
  registerNo: string;
  initial: Partial<CustomerInputRaw>;
  /** ХУР-аас автоматаар бөглөгдсөн талбарууд (унших зорилгоор тэмдэглэнэ). */
  prefilled: readonly string[];
  /** Сервер талын (VALIDATION_FAILED) алдаа: талбарын замтай. */
  serverIssues: { path: string; message: string }[];
  submitting: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
}

const L = (k: string) => t(`customer.field.${k}`);
const req = { required: true, message: t('customer.error.required') };

type Path = (string | number)[];
const ADDRESS_KEYS = ['province', 'district', 'khoroo', 'detail'] as const;
const SEGMENT_OPTIONS = ['Жижиглэн', 'ЖДҮ', 'Хөдөө аж ахуй', 'Корпорейт'].map((value) => ({ value }));

/** Талбаруудыг нэг мөрөнд тэгш байрлуулна: тор (grid) — шошго хоёр мөр болсон ч талбар зэрэгцэж, доош шилжихгүй. */
function FieldGrid({ children, min = 240 }: { children: React.ReactNode; min?: number }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, columnGap: 12, alignItems: 'start' }}>{children}</div>;
}

/** 4 түвшинт хаяг (аймаг/хот → сум/дүүрэг → баг/хороо → дэлгэрэнгүй). Албан ёсны, оршин суугаа, холбоо барих хүний гэрийн хаягт нэг бүтэц. */
function AddressFields({ name, disabled, required = true }: { name: Path; disabled?: boolean; required?: boolean }) {
  return (
    <FieldGrid min={180}>
      {ADDRESS_KEYS.map((k) => (
        <Form.Item key={k} name={[...name, k]} label={L(`address.${k}`)} rules={required ? [req] : undefined}>
          <Input maxLength={k === 'detail' ? 300 : 100} disabled={disabled} />
        </Form.Item>
      ))}
    </FieldGrid>
  );
}

/** Холбоо барих хүний гэрийн хаяг + «Оршин суугаа хаягтай ижил» (сонговол хаягийг хуулж түгжинэ). */
function ContactHomeAddress({ form, index, residence }: { form: ReturnType<typeof Form.useForm<Values>>[0]; index: number; residence: () => Record<string, string> | undefined }) {
  const same = Form.useWatch(['contacts', index, 'homeSame'], form) as boolean | undefined;
  const copy = (checked: boolean) => {
    if (checked) form.setFieldValue(['contacts', index, 'homeAddress'], { ...residence() });
  };
  return (
    <div style={{ marginTop: 4 }}>
      <Flex gap={12} align="center" wrap style={{ marginBottom: 8 }}>
        <Typography.Text strong>{L('contacts.homeAddress')}</Typography.Text>
        <Form.Item name={[index, 'homeSame']} valuePropName="checked" style={{ marginBottom: 0 }}>
          <Checkbox onChange={(e) => copy(e.target.checked)}>{L('contacts.homeSameAsResidence')}</Checkbox>
        </Form.Item>
      </Flex>
      <AddressFields name={[index, 'homeAddress']} disabled={!!same} required={false} />
    </div>
  );
}

const stripHomeSame = (values: Values): Values => ({ ...values, contacts: ((values.contacts as Values[] | undefined) ?? []).map(({ homeSame: _h, ...c }) => c) });

/** FR-2.3 / FR-2.4: харилцагчийн бүрэн маягт. Заавал талбарыг `@los/contracts`-ийн `CustomerInput`-аар шалгана (сервертэй ижил). */
export function CustomerForm({ customerType, registerNo, initial, prefilled, serverIssues, submitting, onSubmit }: Props) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<Values>();
  const individual = customerType === 'INDIVIDUAL';
  const same = Form.useWatch('residenceSameAsOfficial', form);
  const [uploading, setUploading] = useState(false);
  const photoId = Form.useWatch('photoFileId', form) as string | undefined;
  /** Харилцагчийн одоогийн оршин суугаа хаяг (чекбокс «ижил» бол албан ёсны). */
  const residence = () => {
    const v = form.getFieldsValue(true) as Values;
    return (v.residenceSameAsOfficial ? v.officialAddress : v.residenceAddress) as Record<string, string> | undefined;
  };

  useEffect(() => {
    form.setFieldsValue({ isPep: false, isRelatedParty: false, residenceSameAsOfficial: false, contacts: [], ...(initial as Values) });
    // Холбоо барих хүний хаяг оршин суугаа хаягтай ижил бол чекбоксыг тэмдэглэнэ
    const v = form.getFieldsValue(true) as Values;
    const res = (v.residenceSameAsOfficial ? v.officialAddress : v.residenceAddress) as Record<string, string> | undefined;
    const cs = (v.contacts as Values[] | undefined) ?? [];
    if (res && cs.some((c) => c.homeAddress)) form.setFieldValue('contacts', cs.map((c) => ({ ...c, homeSame: !!c.homeAddress && ADDRESS_KEYS.every((k) => (c.homeAddress as Record<string, string>)[k] === res[k]) })));
  }, [form, initial]);

  // Серверийн алдааг талбар дээр харуулна
  useEffect(() => {
    if (!serverIssues.length) return;
    form.setFields(serverIssues.map((i) => ({ name: i.path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)), errors: [i.message] })));
  }, [form, serverIssues]);

  const submit = (values: Values) => {
    const payload = buildPayload(stripHomeSame(values), { customerType, registerNo });
    const issues = validateCustomer(payload);
    if (issues.length) {
      // Бүх талбарын алдааг цэвэрлээд зөвхөн одоогийн алдаануудыг тавина
      form.setFields(issues.map((i) => ({ name: i.name, errors: [i.message] })));
      form.scrollToField(issues[0]!.name);
      void message.error(t('customer.new.fixErrors'));
      return;
    }
    onSubmit(payload);
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const f = await uploadDmsFile(file);
      form.setFieldValue('photoFileId', f.id);
      form.setFields([{ name: 'photoFileId', errors: [] }]);
      void message.success(t('customer.new.photoUploaded'));
    } catch {
      void message.error(t('customer.new.photoFailed'));
    } finally {
      setUploading(false);
    }
  };

  const marked = (name: string) => (prefilled.includes(name) ? { extra: <Typography.Text type="secondary">{t('customer.xyp.prefilled')}</Typography.Text> } : {});

  return (
    <Form<Values> form={form} layout="vertical" onFinish={submit} requiredMark="optional" scrollToFirstError>
      <Card size="small" title={t('customer.group.personal')} style={{ marginBottom: 16 }}>
        <Flex gap={12} wrap>
          {individual ? <Form.Item name="clanName" label={L('clanName')} style={{ flex: '1 1 200px' }} {...marked('clanName')}><Input maxLength={100} /></Form.Item> : null}
          {individual ? <Form.Item name="lastName" label={L('lastName')} rules={[req]} style={{ flex: '1 1 200px' }} {...marked('lastName')}><Input maxLength={100} /></Form.Item> : null}
          <Form.Item name="firstName" label={L('firstName')} rules={[req]} style={{ flex: '1 1 200px' }} {...marked('firstName')}><Input maxLength={100} /></Form.Item>
          {individual ? (
            <Form.Item name="gender" label={L('gender')} rules={[req]} style={{ flex: '1 1 160px' }} {...marked('gender')}>
              <Select options={Gender.map((v) => ({ value: v, label: t(`customer.gender.${v}`) }))} />
            </Form.Item>
          ) : null}
          {individual ? <Form.Item name="civilId" label={L('civilId')} style={{ flex: '1 1 200px' }} {...marked('civilId')}><Input maxLength={30} /></Form.Item> : null}
          {individual ? <Form.Item name="birthDate" label={L('birthDate')} rules={[req]} style={{ flex: '1 1 160px' }} {...marked('birthDate')}><Input type="date" /></Form.Item> : null}
        </Flex>
        <Flex gap={12} wrap>
          <Form.Item name="phone" label={L('phone')} rules={[req]} style={{ flex: '1 1 200px' }}><Input maxLength={20} placeholder="99112233" inputMode="tel" /></Form.Item>
          <Form.Item name="email" label={L('email')} rules={[req, { type: 'email', message: t('customer.error.email') }]} style={{ flex: '1 1 240px' }}><Input maxLength={200} /></Form.Item>
          <Form.Item name="activitySector" label={L('activitySector')} rules={[req]} style={{ flex: '1 1 240px' }} {...marked('activitySector')}><Input maxLength={200} /></Form.Item>
          <Form.Item name="segment" label={L('segment')} rules={[req]} style={{ flex: '1 1 200px' }} {...marked('segment')}><AutoComplete options={SEGMENT_OPTIONS} maxLength={100} filterOption={false} /></Form.Item>
        </Flex>
        {individual ? (
          <Flex gap={12} wrap>
            <Form.Item name="familySize" label={L('familySize')} rules={[req]} style={{ flex: '1 1 140px' }} {...marked('familySize')}><InputNumber min={1} max={30} precision={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="maritalStatus" label={L('maritalStatus')} rules={[req]} style={{ flex: '1 1 180px' }} {...marked('maritalStatus')}>
              <Select options={MaritalStatus.map((v) => ({ value: v, label: t(`customer.maritalStatus.${v}`) }))} />
            </Form.Item>
            <Form.Item name="education" label={L('education')} rules={[req]} style={{ flex: '1 1 200px' }}><Input maxLength={100} /></Form.Item>
            <Form.Item label={L('photoFileId')} required style={{ flex: '1 1 240px' }}>
              <Form.Item name="photoFileId" noStyle rules={[req]}><Input type="hidden" /></Form.Item>
              <Upload accept=".png,.jpg,.jpeg,.pdf" showUploadList={false} beforeUpload={(f) => { void upload(f); return false; }} maxCount={1}>
                <Button loading={uploading}>{photoId ? t('customer.new.photoUploaded') : t('customer.new.photoUpload')}</Button>
              </Upload>
            </Form.Item>
          </Flex>
        ) : null}
      </Card>

      <Card size="small" title={t('customer.group.address')} style={{ marginBottom: 16 }}>
        <Typography.Text strong>{L('officialAddress')}</Typography.Text>
        <div style={{ marginTop: 8 }}><AddressFields name={['officialAddress']} /></div>
        <Form.Item name="residenceSameAsOfficial" valuePropName="checked"><Checkbox>{L('residenceSameAsOfficial')}</Checkbox></Form.Item>
        {!same ? (<><Typography.Text strong>{L('residenceAddress')}</Typography.Text><div style={{ marginTop: 8 }}><AddressFields name={['residenceAddress']} /></div></>) : null}
      </Card>

      {individual ? (
        <Card size="small" title={t('customer.group.employment')} style={{ marginBottom: 16 }}>
          <FieldGrid min={400}>
            <Form.Item name={['employment', 'organization']} label={L('employment.organization')} rules={[req]}><Input maxLength={200} /></Form.Item>
            <Form.Item name={['employment', 'position']} label={L('employment.position')} rules={[req]}><Input maxLength={200} /></Form.Item>
            <Form.Item name={['employment', 'address']} label={L('employment.address')}><Input maxLength={300} /></Form.Item>
            <Form.Item name={['employment', 'phone']} label={L('employment.phone')}><Input maxLength={20} /></Form.Item>
            <Form.Item name={['employment', 'social']} label={L('employment.social')}><Input maxLength={300} /></Form.Item>
          </FieldGrid>
        </Card>
      ) : null}

      <Card size="small" title={t('customer.group.contacts')} style={{ marginBottom: 16 }}>
        <Form.List name="contacts">
          {(fields, { add, remove }) => (
            <>
              {fields.map((f, i) => (
                <div key={f.key}>
                  {i > 0 ? <Divider style={{ margin: '8px 0 16px' }} /> : null}
                  <Flex gap={12} wrap align="flex-start">
                    <Form.Item name={[f.name, 'relation']} label={L('contacts.relation')} rules={[req]} style={{ flex: '1 1 160px' }}>
                      <Select options={CustomerContactRelation.map((v) => ({ value: v, label: t(`customer.relation.${v}`) }))} />
                    </Form.Item>
                    <Form.Item name={[f.name, 'lastName']} label={L('contacts.lastName')} style={{ flex: '1 1 160px' }}><Input maxLength={100} /></Form.Item>
                    <Form.Item name={[f.name, 'firstName']} label={L('contacts.firstName')} rules={[req]} style={{ flex: '1 1 160px' }}><Input maxLength={100} /></Form.Item>
                    <Form.Item name={[f.name, 'phone']} label={L('contacts.phone')} rules={[req]} style={{ flex: '1 1 140px' }}><Input maxLength={20} /></Form.Item>
                    <Form.Item name={[f.name, 'registerNo']} label={L('contacts.registerNo')} style={{ flex: '1 1 140px' }}><Input maxLength={16} /></Form.Item>
                    <Form.Item name={[f.name, 'employment']} label={L('contacts.employment')} style={{ flex: '1 1 200px' }}><Input maxLength={200} /></Form.Item>
                    <Button danger type="link" onClick={() => remove(f.name)} style={{ marginTop: 30 }}>{t('customer.new.removeContact')}</Button>
                  </Flex>
                  <ContactHomeAddress form={form} index={f.name} residence={residence} />
                </div>
              ))}
              {fields.length < 10 ? <Button type="dashed" onClick={() => add()}>{t('customer.new.addContact')}</Button> : null}
            </>
          )}
        </Form.List>
      </Card>

      <Card size="small" title={t('customer.group.kyc')} style={{ marginBottom: 16 }}>
        <Flex gap={24} wrap>
          <Form.Item name="isRelatedParty" valuePropName="checked" style={{ marginBottom: 0 }}><Checkbox>{L('isRelatedParty')}</Checkbox></Form.Item>
          <Form.Item name="isPep" valuePropName="checked" style={{ marginBottom: 0 }}><Checkbox>{L('isPep')}</Checkbox></Form.Item>
        </Flex>
      </Card>

      <Button type="primary" htmlType="submit" loading={submitting} data-testid="customer-submit">{t('customer.new.submit')}</Button>
    </Form>
  );
}
