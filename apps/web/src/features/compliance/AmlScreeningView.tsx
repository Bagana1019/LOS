'use client';
import type { ReactNode } from 'react';
import { Alert, Card, Col, Descriptions, Flex, Row, Tag, Typography } from 'antd';
import type { AmlHit, AmlHitReviewRequest, AmlScreeningDetail } from '@los/contracts';
import { EMPTY_VALUE, formatDateTime, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { AML_QUEUE_HREF, blockingNotice, hitEvidence, isOwnScreening } from './aml.utils';
import { AmlReviewForm } from './AmlReviewForm';
import { SeverityTag } from './SeverityTag';

const { Title, Link } = Typography;

export interface AmlScreeningViewProps {
  detail: AmlScreeningDetail;
  currentUserId: string | null;
  submittingHitId: string | null;
  onReview: (hitId: string, body: AmlHitReviewRequest) => void;
}

const STATUS_COLOR: Record<AmlScreeningDetail['status'], string> = {
  CLEAR: 'green', WARNING: 'gold', REVIEW_REQUIRED: 'orange', CONFIRMED_MATCH: 'red', CLEARED_AFTER_REVIEW: 'green',
};
const orDash = (v: ReactNode) => (v === null || v === undefined || v === '' ? EMPTY_VALUE : v);
const join = (xs: readonly string[]) => (xs.length ? xs.join(', ') : EMPTY_VALUE);

/** Шалгасан харилцагч (регистр масклагдсан, төрсөн он л — kyc-ийн `subject`). */
function SubjectPanel({ detail }: { detail: AmlScreeningDetail }) {
  const s = detail.subject;
  return (
    <section data-testid="aml-subject">
      <Card size="small" title={t('aml.subject.title')}>
        <Descriptions size="small" column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label={t('aml.subject.name')}>{detail.subjectName}</Descriptions.Item>
          <Descriptions.Item label={t('aml.subject.register')}>{detail.registerNoMasked}</Descriptions.Item>
          <Descriptions.Item label={t('aml.subject.type')}>{t(`aml.subjectType.${s.subjectType}`)}</Descriptions.Item>
          <Descriptions.Item label={t('aml.subject.birthYear')}>{orDash(s.birthYear)}</Descriptions.Item>
          <Descriptions.Item label={t('aml.subject.countries')}>{join(s.countries)}</Descriptions.Item>
          <Descriptions.Item label={t('aml.subject.aliases')}>{join(s.aliases)}</Descriptions.Item>
          <Descriptions.Item label={t('aml.subject.pep')}>{t(s.isPep ? 'aml.yes' : 'aml.no')}</Descriptions.Item>
        </Descriptions>
      </Card>
    </section>
  );
}

/** Hit ↔ харилцагч зэрэгцүүлэн (зүүн: харилцагч, баруун: жагсаалтын бүртгэл). */
function SideBySide({ hit, detail }: { hit: AmlHit; detail: AmlScreeningDetail }) {
  const e = hitEvidence(hit);
  return (
    <Row gutter={16}>
      <Col xs={24} md={12}>
        <Descriptions size="small" column={1} title={t('aml.hit.customer')} bordered>
          <Descriptions.Item label={t('aml.hit.name')}>{detail.subjectName}</Descriptions.Item>
          <Descriptions.Item label={t('aml.subject.register')}>{detail.registerNoMasked}</Descriptions.Item>
          <Descriptions.Item label={t('aml.hit.birth')}>{orDash(detail.subject.birthYear)}</Descriptions.Item>
          <Descriptions.Item label={t('aml.hit.countries')}>{join(detail.subject.countries)}</Descriptions.Item>
        </Descriptions>
      </Col>
      <Col xs={24} md={12}>
        <Descriptions size="small" column={1} title={t('aml.hit.entry')} bordered>
          <Descriptions.Item label={t('aml.hit.name')}>{e.name}</Descriptions.Item>
          <Descriptions.Item label={t('aml.hit.ref')}>{hit.entryRef}</Descriptions.Item>
          <Descriptions.Item label={t('aml.hit.birth')}>{orDash(e.dob)}</Descriptions.Item>
          <Descriptions.Item label={t('aml.hit.countries')}>{join(e.countries)}</Descriptions.Item>
          {e.programme ? <Descriptions.Item label={t('aml.hit.programme')}>{e.programme}</Descriptions.Item> : null}
          {e.listedOn ? <Descriptions.Item label={t('aml.hit.listedOn')}>{e.listedOn}</Descriptions.Item> : null}
          {e.category ? <Descriptions.Item label={t('aml.hit.category')}>{e.category}</Descriptions.Item> : null}
          {e.reasonCode ? <Descriptions.Item label={t('aml.hit.reasonCode')}>{e.reasonCode}</Descriptions.Item> : null}
        </Descriptions>
      </Col>
    </Row>
  );
}

function Decision({ hit }: { hit: AmlHit }) {
  return (
    <Descriptions size="small" column={{ xs: 1, md: 3 }}>
      <Descriptions.Item label={t('aml.review.decision')}>{t(`aml.hitStatus.${hit.status}`)}</Descriptions.Item>
      <Descriptions.Item label={t('aml.hit.reviewedBy')}>{orDash(hit.reviewedBy)}</Descriptions.Item>
      <Descriptions.Item label={t('aml.hit.reviewedAt')}>{formatDateTime(hit.reviewedAt)}</Descriptions.Item>
      <Descriptions.Item label={t('aml.hit.reviewComment')} span={3}>{orDash(hit.reviewComment)}</Descriptions.Item>
    </Descriptions>
  );
}

function HitCard({ hit, own, ...p }: { hit: AmlHit; own: boolean } & AmlScreeningViewProps) {
  const title = (
    <Flex gap={8} wrap align="center">
      <span>{t(`aml.list.${hit.list}`)}</span>
      <SeverityTag severity={hit.severity} />
      <Tag>{t(`aml.matchType.${hit.matchType}`)}</Tag>
      <span>{t('aml.hit.score')}: {formatPercent(hit.score, 0)}</span>
    </Flex>
  );
  return (
    <article data-testid={`aml-hit-${hit.id}`}>
      <Card size="small" title={title} extra={<Tag>{t(`aml.hitStatus.${hit.status}`)}</Tag>}>
        <Flex vertical gap={16}>
          <SideBySide hit={hit} detail={p.detail} />
          {hit.status !== 'OPEN' ? <Decision hit={hit} /> : null}
          {hit.status === 'OPEN' && own ? <Alert type="info" showIcon message={t('aml.review.selfReview')} /> : null}
          {hit.status === 'OPEN' && !own ? <AmlReviewForm hitId={hit.id} hitName={hitEvidence(hit).name} customerName={p.detail.subjectName} submitting={p.submittingHitId === hit.id} onSubmit={p.onReview} /> : null}
        </Flex>
      </Card>
    </article>
  );
}

/** Нэг шалгалтын дэлгэрэнгүй: харилцагч, hit бүрийн нотолгоо зэрэгцүүлэн, шийдвэрийн маягт (docs/05-compliance-aml.md §5). */
export function AmlScreeningView(props: AmlScreeningViewProps) {
  const { detail, currentUserId } = props;
  const own = isOwnScreening(detail.screenedBy, currentUserId);
  const notice = blockingNotice(detail.status, detail.blocking);
  return (
    <Flex vertical gap={16}>
      <Link href={AML_QUEUE_HREF}>{t('aml.detail.back')}</Link>
      <Flex gap={12} align="center" wrap>
        <Title level={3} style={{ margin: 0 }}>{t('aml.detail.title')}</Title>
        <Tag color={STATUS_COLOR[detail.status]}>{t(`aml.status.${detail.status}`)}</Tag>
        <span>{t('aml.detail.risk')}: {t(`aml.risk.${detail.riskLevel}`)} ({detail.riskScore})</span>
      </Flex>
      {notice ? <Alert type={notice.type} showIcon message={t(notice.key)} /> : null}
      <Descriptions size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label={t('aml.detail.screenedBy')}>{orDash(detail.screenedBy)}</Descriptions.Item>
        <Descriptions.Item label={t('aml.detail.screenedAt')}>{formatDateTime(detail.screenedAt)}</Descriptions.Item>
      </Descriptions>
      <SubjectPanel detail={detail} />
      {detail.hits.map((hit) => <HitCard key={hit.id} hit={hit} own={own} {...props} />)}
    </Flex>
  );
}
