export interface QuestionnaireTemplateItem {
  id: string;
  label?: string;
  type?: string;
  when?: { item_id: string; equals: string };
  followups?: Record<string, QuestionnaireTemplateItem[] | undefined>;
}

export interface FlattenedTemplateItem {
  id: string;
  label?: string;
  type?: string;
  isConditional: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const flattenTemplateItems = (
  items: QuestionnaireTemplateItem[] | undefined,
  parentConditional = false
): FlattenedTemplateItem[] => {
  if (!items || items.length === 0) return [];

  const result: FlattenedTemplateItem[] = [];

  items.forEach((item) => {
    const isConditional = parentConditional || Boolean(item.when);
    result.push({
      id: item.id,
      label: item.label,
      type: item.type,
      isConditional,
    });

    if (item.followups && isObject(item.followups)) {
      Object.values(item.followups).forEach((children) => {
        if (!children) return;
        result.push(...flattenTemplateItems(children, true));
      });
    }
  });

  return result;
};

export const hasAnswer = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 || value === '0' || value === '0.0';
  }

  if (typeof value === 'number') {
    return !Number.isNaN(value);
  }

  if (typeof value === 'boolean') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((v) => {
      if (v === null || v === undefined) return false;
      if (typeof v === 'string') return v.trim().length > 0 || v === '0' || v === '0.0';
      if (typeof v === 'number') return !Number.isNaN(v);
      if (typeof v === 'boolean') return true;
      if (Array.isArray(v)) return hasAnswer(v);
      if (isObject(v)) return hasAnswer(v);
      return true;
    });
  }

  if (isObject(value)) {
    const maybeAnnotation = value as {
      points?: unknown;
      paths?: unknown;
    };
    if (Array.isArray(maybeAnnotation.points) || Array.isArray(maybeAnnotation.paths)) {
      const hasPoints = Array.isArray(maybeAnnotation.points)
        ? maybeAnnotation.points.some((point) => hasAnswer(point))
        : false;
      const hasPaths = Array.isArray(maybeAnnotation.paths)
        ? maybeAnnotation.paths.some((path) => hasAnswer(path))
        : false;
      if (hasPoints || hasPaths) return true;
    }
    return Object.values(value).some((entry) => hasAnswer(entry));
  }

  return true;
};
