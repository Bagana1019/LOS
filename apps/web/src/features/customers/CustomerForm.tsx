'use client';
import { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Checkbox, Divider, Flex, Form, Input, InputNumber, Select, Typography, Upload } from 'antd';
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

function AddressFields({ name }: { name: string }) {
  return (
    <Flex gap={12} wrap>
      {(['province', 'district', 'khoroo', 'detail'] as const).map((k) => (
        <Form.Item key={k} name={[name, k]} label={L(`address.${k}`)} rules={[req]} style={{ flex: k === 'detail' ? '2 1 280px' : '1 1 160px' }}>
          <Input maxLength={k === 'detail' ? 300 : 100} />
        </Form.Item>
      ))}
    </Flex>
  );
}

/** FR-2.3 / FR-2.4: харилцагчийн бүрэн маягт. Заавал талбарыг `@los/contracts`-ийн `CustomerInput`-аар шалгана (сервертэй ижил). */
export function CustomerForm({ customerType, registerNo, initial, prefilled, serverIssues, submitting, onSubmit }: Props) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<Values>();
  const individual = customerType === 'INDIVIDUAL';
  const same = Form.useWatch('residenceSameAsOfficial', form);
  const [uploading, setUploading] = useState(false);
  const photoId = Form.useWatch('photoFileId', form) as string | undefined;

  useEffect(() => {
    form.setFieldsValue({ isPep: false, isRelatedParty: false, residenceSameAsOfficial: false, contacts: [], ...(initial as Values) });
  }, [form, initial]);

  // Серверийн алдааг талбар дээр харуулна
  useEffect(() => {
    if (!serverIssues.length) return;
    form.setFields(serverIssues.map((i) => ({ name: i.path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)), errors: [i.message] })));
  }, [form, serverIssues]);

  const submit = (values: Values) => {
    const payload = buildPayload(values, { customerType, registerNo });
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
          {individual ? <Form.Item name="lastName" label={L('lastName')} rules={[req]} style={{ flex: '1 1 200px' }} {...marked('lastName')}><Input maxLength={100} /></Form.Item> : null}
          <Form.Item name="firstName" label={L('firstName')} rules={[req]} style={{ flex: '1 1 200px' }} {...marked('firstName')}><Input maxLength={100} /></Form.Item>
          {individual ? (
            <Form.Item name="gender" label={L('gender')} rules={[req]} style={{ flex: '1 1 160px' }} {...marked('gender')}>
              <Select options={Gender.map((v) => ({ value: v, label: t(`customer.gender.${v}`) }))} />
            </Form.Item>
          ) : null}
          {individual ? <Form.Item name="birthDate" label={L('birthDate')} rules={[req]} style={{ flex: '1 1 160px' }} {...marked('birthDate')}><Input type="date" /></Form.Item> : null}
        </Flex>
        <Flex gap={12} wrap>
          <Form.Item name="phone" label={L('phone')} rules={[req]} style={{ flex: '1 1 200px' }}><Input maxLength={20} placeholder="99112233" inputMode="tel" /></Form.Item>
          <Form.Item name="email" label={L('email')} rules={[req, { type: 'email', message: t('customer.error.email') }]} style={{ flex: '1 1 240px' }}><Input maxLength={200} /></Form.Item>
          <Form.Item name="activitySector" label={L('activitySector')} rules={[req]} style={{ flex: '1 1 240px' }} {...marked('activitySector')}><Input maxLength={200} /></Form.Item>
          <Form.Item name="segment" label={L('segment')} rules={[req]} style={{ flex: '1 1 200px' }}><Input maxLength={100} /></Form.Item>
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
        <div style={{ marginTop: 8 }}><AddressFields name="officialAddress" /></div>
        <Form.Item name="residenceSameAsOfficial" valuePropName="checked"><Checkbox>{L('residenceSameAsOfficial')}</Checkbox></Form.Item>
        {!same ? (<><Typography.Text strong>{L('residenceAddress')}</Typography.Text><div style={{ marginTop: 8 }}><AddressFields name="residenceAddress" /></div></>) : null}
      </Card>

      {individual ? (
        <Card size="small" title={t('customer.group.employment')} style={{ marginBottom: 16 }}>
          <Flex gap={12} wrap>
            <Form.Item name={['employment', 'organization']} label={L('employment.organization')} rules={[req]} style={{ flex: '1 1 240px' }}><Input maxLength={200} /></Form.Item>
            <Form.Item name={['employment', 'position']} label={L('employment.position')} rules={[req]} style={{ flex: '1 1 200px' }}><Input maxLength={200} /></Form.Item>
            <Form.Item name={['employment', 'address']} label={L('employment.address')} style={{ flex: '1 1 240px' }}><Input maxLength={300} /></Form.Item>
            <Form.Item name={['employment', 'phone']} label={L('employment.phone')} style={{ flex: '1 1 160px' }}><Input maxLength={20} /></Form.Item>
            <Form.Item name={['employment', 'social']} label={L('employment.social')} style={{ flex: '1 1 240px' }}><Input maxLength={300} /></Form.Item>
          </Flex>
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
                    <Form.Item name={[f.name, 'homeAddress']} label={L('contacts.homeAddress')} style={{ flex: '2 1 240px' }}><Input maxLength={300} /></Form.Item>
                    <Button danger type="link" onClick={() => remove(f.name)} style={{ marginTop: 30 }}>{t('customer.new.removeContact')}</Button>
                  </Flex>
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
