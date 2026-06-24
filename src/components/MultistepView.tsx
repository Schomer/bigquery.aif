'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import type { CompositionEnvelope, SkillName, DataManagementResult } from '@/lib/types';
import { ChatOrchestrator } from '@/lib/chat-orchestrator';
import { ArtifactCard } from './ArtifactCard';

interface Step {
  skill: SkillName;
  description: string;
  prompt: string;
}

interface StepState {
  skill: SkillName;
  description: string;
  prompt: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'ERROR';
  envelopes?: CompositionEnvelope[];
  error?: string;
}

interface Props {
  envelope: CompositionEnvelope;
  onSendMessage: (msg: string) => void;
}

export function MultistepView({ envelope, onSendMessage }: Props) {
  const { activeProject } = useAuth();
  const data = envelope.primaryArtifact.data as { steps: Step[] };
  const steps = data?.steps || [];

  const [stepStates, setStepStates] = useState<StepState[]>(() =>
    steps.map((s) => ({
      ...s,
      status: 'PENDING',
    }))
  );
  const [currentStepIndex, setCurrentStepIndex] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(true);
  const [accumulatedContext, setAccumulatedContext] = useState<any>({});
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});

  // Helper to update the conversation context based on step output
  const updateAccumulatedContext = (prevContext: any, envelopes: CompositionEnvelope[]) => {
    if (!envelopes || envelopes.length === 0) return prevContext;
    const last = envelopes[envelopes.length - 1];

    let stepTable = undefined;
    let stepDataset = undefined;
    if (last.skill === 'schema') {
      const schemaData = last.primaryArtifact.data as { dataset?: string; table?: string } | null;
      stepTable = schemaData?.table;
      stepDataset = schemaData?.dataset;
    } else if (last.skill === 'data-quality') {
      const dqData = last.primaryArtifact.data as { table?: string } | null;
      stepTable = dqData?.table;
    } else if (last.skill === 'data-management') {
      const dmData = last.primaryArtifact.data as { table?: string } | null;
      stepTable = dmData?.table;
    }

    return {
      ...prevContext,
      lastSkill: last.skill,
      lastResultRef: last.id,
      ...(stepTable ? { lastTable: stepTable } : {}),
      ...(stepDataset ? { dataset: stepDataset } : {}),
    };
  };

  const executeStep = async (index: number, currentContext: any) => {
    const step = steps[index];
    setStepStates((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], status: 'RUNNING' };
      return next;
    });

    try {
      const response = await ChatOrchestrator.processMessage({
        message: step.prompt,
        history: stepStates
          .filter((s, idx) => idx < index && s.status === 'COMPLETED' && s.envelopes)
          .flatMap((s) => [
            { role: 'user' as const, content: s.prompt, timestamp: new Date().toISOString() },
            { role: 'assistant' as const, content: s.envelopes?.[0]?.headline?.text || '', envelopes: s.envelopes, timestamp: new Date().toISOString() },
          ]),
        context: {
          ...currentContext,
          project: activeProject || undefined,
          forcedSkill: step.skill,
        },
      });

      const envelopes = response.envelopes || [];
      const hasConfirmation = envelopes.some((e) => e.requiresConfirmation);

      setStepStates((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          status: hasConfirmation ? 'RUNNING' : 'COMPLETED',
          envelopes,
        };
        return next;
      });

      // Automatically expand completed step
      setExpandedSteps((prev) => ({ ...prev, [index]: true }));

      if (hasConfirmation) {
        // Halt execution flow for user confirmation
        return;
      }

      const nextContext = updateAccumulatedContext(currentContext, envelopes);
      setAccumulatedContext(nextContext);

      if (index + 1 < steps.length) {
        setCurrentStepIndex(index + 1);
        executeStep(index + 1, nextContext);
      } else {
        setIsRunning(false);
        setCurrentStepIndex(null);
      }
    } catch (err: any) {
      setStepStates((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          status: 'ERROR',
          error: err?.message || String(err),
        };
        return next;
      });
      setIsRunning(false);
      setCurrentStepIndex(null);
    }
  };

  const handleStepConfirm = async (index: number, stepEnvelope: CompositionEnvelope) => {
    setStepStates((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], status: 'RUNNING' };
      return next;
    });

    try {
      const response = await ChatOrchestrator.processMessage({
        message: 'confirm',
        history: [],
        context: {
          project: activeProject || undefined,
          confirmedPayload: stepEnvelope.primaryArtifact.data as DataManagementResult,
        },
      });

      const envelopes = response.envelopes || [];

      setStepStates((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          status: 'COMPLETED',
          envelopes,
        };
        return next;
      });

      const nextContext = updateAccumulatedContext(accumulatedContext, envelopes);
      setAccumulatedContext(nextContext);

      if (index + 1 < steps.length) {
        setCurrentStepIndex(index + 1);
        executeStep(index + 1, nextContext);
      } else {
        setIsRunning(false);
        setCurrentStepIndex(null);
      }
    } catch (err: any) {
      setStepStates((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          status: 'ERROR',
          error: err?.message || String(err),
        };
        return next;
      });
      setIsRunning(false);
      setCurrentStepIndex(null);
    }
  };

  const handleStepCancel = (index: number) => {
    setStepStates((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        status: 'ERROR',
        error: 'Workflow cancelled by user.',
      };
      return next;
    });
    setIsRunning(false);
    setCurrentStepIndex(null);
  };

  // Trigger initial step execution
  useEffect(() => {
    if (steps.length > 0 && currentStepIndex === null && isRunning) {
      const allPending = stepStates.every((s) => s.status === 'PENDING');
      if (allPending) {
        setCurrentStepIndex(0);
        executeStep(0, {});
      }
    }
  }, [steps, isRunning, currentStepIndex]);

  const completedCount = stepStates.filter((s) => s.status === 'COMPLETED').length;
  const progressPercent = steps.length > 0 ? (completedCount / steps.length) * 100 : 0;

  const toggleExpand = (index: number) => {
    setExpandedSteps((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Workflow Header & Progress */}
      <div style={{
        background: 'linear-gradient(135deg, #f0f4ff 0%, #e6eeff 100%)',
        padding: '16px 20px',
        borderRadius: 8,
        border: '1px solid #d0e0ff',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#1a73e8',
            background: '#d9e8ff',
            padding: '2px 8px',
            borderRadius: 12,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Workflow Execution
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {completedCount} of {steps.length} completed
          </span>
        </div>
        <div style={{
          width: '100%',
          height: 6,
          background: '#e0e0e0',
          borderRadius: 3,
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${progressPercent}%`,
            height: '100%',
            background: '#1a73e8',
            transition: 'width 0.4s ease',
          }} />
        </div>
      </div>

      {/* Steps Timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', paddingLeft: 8 }}>
        {stepStates.map((step, i) => {
          const isCurrent = currentStepIndex === i;
          const isCompleted = step.status === 'COMPLETED';
          const isRunningStep = step.status === 'RUNNING';
          const isError = step.status === 'ERROR';

          // Color tokens
          let iconBg = '#f1f3f4';
          let iconColor = 'var(--text-muted)';
          let iconName = 'radio_button_unchecked';
          let spin = false;

          if (isRunningStep) {
            iconBg = '#e8f0fe';
            iconColor = '#1a73e8';
            iconName = 'sync';
            spin = true;
          } else if (isCompleted) {
            iconBg = '#e6f4ea';
            iconColor = '#137333';
            iconName = 'check_circle';
          } else if (isError) {
            iconBg = '#fce8e6';
            iconColor = '#c5221f';
            iconName = 'error';
          }

          return (
            <div key={i} style={{ display: 'flex', position: 'relative', paddingBottom: i === steps.length - 1 ? 0 : 24 }}>
              {/* Connecting line */}
              {i < steps.length - 1 && (
                <div style={{
                  position: 'absolute',
                  left: 12,
                  top: 24,
                  bottom: 0,
                  width: 2,
                  background: isCompleted ? '#e6f4ea' : '#e0e0e0',
                  zIndex: 1,
                }} />
              )}

              {/* Step Circle Icon */}
              <div style={{
                width: 26,
                height: 26,
                borderRadius: '50%',
                background: iconBg,
                color: iconColor,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
                marginRight: 16,
                flexShrink: 0,
                boxShadow: isCurrent ? '0 0 0 3px rgba(26,115,232,0.2)' : 'none',
              }}>
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 16,
                    animation: spin ? 'spin 1.5s linear infinite' : 'none',
                    display: 'inline-block',
                  }}
                >
                  {iconName}
                </span>
              </div>

              {/* Step Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <h4 style={{
                    margin: 0,
                    fontSize: 14,
                    fontWeight: isCurrent || isRunningStep ? 600 : 500,
                    color: isCurrent || isRunningStep ? '#1a73e8' : 'var(--text)',
                  }}>
                    {step.description}
                  </h4>
                  {step.envelopes && step.envelopes.length > 0 && (
                    <button
                      onClick={() => toggleExpand(i)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        fontSize: 11,
                        padding: '2px 6px',
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 2,
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-2)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                        {expandedSteps[i] ? 'expand_less' : 'expand_more'}
                      </span>
                      {expandedSteps[i] ? 'Hide Output' : 'Show Output'}
                    </button>
                  )}
                </div>

                <p style={{
                  margin: '4px 0 0',
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                }}>
                  {step.prompt}
                </p>

                {/* Step error rendering */}
                {isError && step.error && (
                  <div style={{
                    marginTop: 8,
                    padding: '8px 12px',
                    background: '#fce8e6',
                    border: '1px solid #fad2cf',
                    borderRadius: 6,
                    color: '#c5221f',
                    fontSize: 12,
                  }}>
                    {step.error}
                  </div>
                )}

                {/* Step output rendering */}
                {step.envelopes && step.envelopes.length > 0 && expandedSteps[i] && (
                  <div style={{
                    marginTop: 12,
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    padding: 8,
                    background: '#fafafa',
                  }}>
                    {step.envelopes.map((env) => (
                      <ArtifactCard
                        key={env.id}
                        envelope={env}
                        onConfirm={() => handleStepConfirm(i, env)}
                        onCancel={() => handleStepCancel(i)}
                        onInlineClick={onSendMessage}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* CSS Animation style block */}
      <style jsx global>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
