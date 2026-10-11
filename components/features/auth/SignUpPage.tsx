"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { SocialIcon } from "@/components/ui/social-icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { AUTH_CONFIG } from "@/lib/constants";

type UsernameStatus = "idle" | "checking" | "available" | "taken" | "invalid" | "error";

const USERNAME_LABEL = "Nome de Usu\u00e1rio";
const USERNAME_HELPER_TEXT = "Use 3 a 24 caracteres: letras, n\u00fameros ou underline.";
const USERNAME_AVAILABLE_TEXT = "Nome de Usu\u00e1rio dispon\u00edvel.";
const USERNAME_TAKEN_TEXT = "Este nome de Usu\u00e1rio j\u00e1 existe.";
const USERNAME_CHECK_ERROR_TEXT = "N\u00e3o foi poss\u00edvel verificar agora. Confirme a migration de username no Supabase.";
const USERNAME_REQUIRED_TEXT = "Escolha um nome de Usu\u00e1rio dispon\u00edvel antes de continuar.";
const EMAIL_ALREADY_REGISTERED_TEXT = "Este e-mail j\u00e1 est\u00e1 cadastrado. Use a p\u00e1gina Entrar para acessar sua conta.";
const COMPANY_OPTIONS = ["LATAM", "GOL", "AZUL"] as const;
const BASE_OPTIONS = ["SAO", "GIG", "FOR", "BSB", "POA"] as const;

type Company = (typeof COMPANY_OPTIONS)[number];
type Base = (typeof BASE_OPTIONS)[number];

export const SignUpPage = () => {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(false);
    const [socialProvider, setSocialProvider] = useState<"google" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>("idle");
    const { addToast } = useToast();
    const [formData, setFormData] = useState({
        fullName: "",
        username: "",
        email: "",
        password: "",
        company: "GOL" as Company,
        base: "SAO" as Base,
    });

    const normalizedUsername = useMemo(() => normalizeUsername(formData.username), [formData.username]);
    const isUsernameReady = usernameStatus === "available" && normalizedUsername.length >= 3;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;

        setFormData(prev => ({
            ...prev,
            [name]: name === "username" ? normalizeUsername(value) : value,
        }));
    };

    const handleCompanyChange = (key: React.Key | null) => {
        const company = String(key) as Company;
        if (!COMPANY_OPTIONS.includes(company)) return;

        setFormData(prev => ({ ...prev, company }));
    };

    const handleBaseChange = (key: React.Key | null) => {
        const base = String(key) as Base;
        if (!BASE_OPTIONS.includes(base)) return;

        setFormData(prev => ({ ...prev, base }));
    };

    useEffect(() => {
        if (!formData.username) {
            setUsernameStatus("idle");
            return;
        }

        if (normalizedUsername.length < 3 || normalizedUsername.length > 24) {
            setUsernameStatus("invalid");
            return;
        }

        let isCancelled = false;
        const timeoutId = window.setTimeout(async () => {
            setUsernameStatus("checking");
            const supabase = createClient();
            const { data, error: usernameError } = await supabase.rpc("is_username_available", {
                candidate: normalizedUsername,
            });

            if (isCancelled) return;
            if (usernameError) {
                setUsernameStatus("error");
                return;
            }

            setUsernameStatus(data === true ? "available" : "taken");
        }, 350);

        return () => {
            isCancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [formData.username, normalizedUsername]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);

        const supabase = createClient();

        try {
            if (!isUsernameReady) {
                throw new Error(USERNAME_REQUIRED_TEXT);
            }

            const { data: authData, error: signUpError } = await supabase.auth.signUp({
                email: formData.email,
                password: formData.password,
                options: {
                    data: {
                        full_name: formData.fullName,
                        username: normalizedUsername,
                        company: formData.company,
                        base: formData.base,
                    },
                    emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(AUTH_CONFIG.afterSignupPath)}`,
                },
            });

            if (signUpError) {
                if (isAlreadyRegisteredError(signUpError)) {
                    throw new Error(EMAIL_ALREADY_REGISTERED_TEXT);
                }

                throw signUpError;
            }

            if (authData.user) {
                // Supabase can return an obfuscated user for an existing address
                // when email confirmation and account-enumeration protection are enabled.
                if (authData.user.identities?.length === 0) {
                    throw new Error(EMAIL_ALREADY_REGISTERED_TEXT);
                }

                if (!authData.session) {
                    addToast({
                        title: "Confirme seu e-mail",
                        description: "Enviamos um link de confirmação para concluir o cadastro.",
                        type: "success",
                    });
                    router.push("/auth");
                    return;
                }

                addToast({
                    title: "Conta criada!",
                    description: "Sua conta está pronta.",
                    type: "success",
                });

                router.push(AUTH_CONFIG.afterSignupPath);
                router.refresh();
            }
        } catch (err: any) {
            const errorMessage = err.message || "Algo deu errado. Tente novamente.";
            setError(errorMessage);
            addToast({
                title: "Falha no cadastro",
                description: errorMessage,
                type: "error",
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleSocialLogin = async (provider: "google") => {
        setError(null);
        setSocialProvider(provider);
        const supabase = createClient();
        const { error: oauthError } = await supabase.auth.signInWithOAuth({
            provider,
            options: {
                redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(AUTH_CONFIG.afterSignupPath)}`,
                queryParams: {
                    access_type: "offline",
                    prompt: "consent",
                },
            },
        });

        if (oauthError) {
            const errorMessage = oauthError.message || "Não foi possível iniciar o cadastro social.";
            setError(errorMessage);
            setSocialProvider(null);
            addToast({
                title: "Falha no cadastro social",
                description: errorMessage,
                type: "error",
            });
        }
    };

    return (
        <div className="flex min-h-screen bg-white">
            <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
                <div className="mx-auto w-full max-w-sm lg:w-96">
                    <div>
                        <BrandLogo size="md" />
                        <h2 className="mt-6 text-3xl font-bold tracking-tight text-gray-900">Criar conta</h2>
                        <p className="mt-2 text-sm text-gray-600">
                            Já tem uma conta?{" "}
                            <Link href="/auth" className="font-medium text-brand-600 hover:text-brand-500">
                                Entrar
                            </Link>
                        </p>
                    </div>

                    <div className="mt-8">
                        <div className="mt-6">
                            {error && (
                                <div className="mb-4 rounded-md bg-red-50 p-4">
                                    <p className="text-sm text-red-700">{error}</p>
                                </div>
                            )}

                            <form onSubmit={handleSubmit} method="POST" className="space-y-6">
                                <Input
                                    label="Nome completo"
                                    name="fullName"
                                    type="text"
                                    placeholder="Digite seu nome"
                                    value={formData.fullName}
                                    onChange={handleChange}
                                    required
                                />

                                <Input
                                    label={USERNAME_LABEL}
                                    name="username"
                                    type="text"
                                    placeholder="ex: tripulante_01"
                                    value={formData.username}
                                    onChange={handleChange}
                                    helperText={getUsernameHelperText(usernameStatus)}
                                    error={usernameStatus === "taken" || usernameStatus === "invalid" || usernameStatus === "error"}
                                    autoComplete="username"
                                    required
                                />

                                <Input
                                    label="E-mail"
                                    name="email"
                                    type="email"
                                    placeholder="Digite seu e-mail"
                                    value={formData.email}
                                    onChange={handleChange}
                                    required
                                />

                                <Select
                                    label="Companhia"
                                    selectedKey={formData.company}
                                    onSelectionChange={handleCompanyChange}
                                    isRequired
                                >
                                    <Select.Item id="LATAM">Latam</Select.Item>
                                    <Select.Item id="GOL">Gol</Select.Item>
                                    <Select.Item id="AZUL">Azul</Select.Item>
                                </Select>

                                <Select
                                    label="Base"
                                    selectedKey={formData.base}
                                    onSelectionChange={handleBaseChange}
                                    isRequired
                                >
                                    {BASE_OPTIONS.map(base => (
                                        <Select.Item key={base} id={base}>{base}</Select.Item>
                                    ))}
                                </Select>

                                <Input
                                    label="Senha"
                                    name="password"
                                    type="password"
                                    placeholder="Crie uma senha"
                                    helperText="Deve ter pelo menos 8 caracteres."
                                    value={formData.password}
                                    onChange={handleChange}
                                    required
                                />

                                <Button type="submit" className="w-full justify-center" isDisabled={isLoading || !isUsernameReady}>
                                    {isLoading ? "Criando conta..." : "Começar"}
                                </Button>
                            </form>
                        </div>

                        <div className="mt-6">
                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-gray-200" />
                                </div>
                                <div className="relative flex justify-center text-sm">
                                    <span className="bg-white px-2 text-gray-500">Ou cadastre-se com</span>
                                </div>
                            </div>

                            <div className="mt-6 grid grid-cols-1 gap-3">
                                <Button
                                    variant="secondary"
                                    className="w-full justify-center gap-2"
                                    onClick={() => handleSocialLogin("google")}
                                    isDisabled={socialProvider !== null}
                                >
                                    <SocialIcon type="google" className="h-5 w-5" />
                                    <span>{socialProvider === "google" ? "Conectando..." : "Google"}</span>
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="relative hidden w-0 flex-1 lg:block">
                <img
                    className="absolute inset-0 h-full w-full object-cover"
                    src="https://images.unsplash.com/photo-1557804506-669a67965ba0?ixlib=rb-1.2.1&auto=format&fit=crop&w=1567&q=80"
                    alt="Imagem de fundo"
                />
                <div className="absolute inset-0 bg-gray-900/10 mix-blend-multiply" />
            </div>
        </div>
    );
};

const normalizeUsername = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);

const isAlreadyRegisteredError = (error: { message?: string; code?: string }) => {
    const message = error.message?.toLowerCase() ?? "";
    return error.code === "user_already_exists" || message.includes("already registered") || message.includes("already exists");
};

const getUsernameHelperText = (status: UsernameStatus) => {
    switch (status) {
        case "checking":
            return "Verificando disponibilidade...";
        case "available":
            return USERNAME_AVAILABLE_TEXT;
        case "taken":
            return USERNAME_TAKEN_TEXT;
        case "invalid":
            return USERNAME_HELPER_TEXT;
        case "error":
            return USERNAME_CHECK_ERROR_TEXT;
        default:
            return USERNAME_HELPER_TEXT;
    }
};
